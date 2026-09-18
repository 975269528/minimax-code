import { performance } from 'node:perf_hooks';

import type {
  CallConnectorToolResult,
  ConnectedConnectorTool,
  ConnectorCallOutcome,
  ConnectorCredentialSnapshot,
  ConnectorHostRequestContext,
  ConnectorInventory,
  ConnectorInventoryTool,
  ConnectorToolHandle,
  HostProcessConnectorCaller,
  HostProcessConnectorGateway,
} from './contracts.js';
import { compileConnectorArgumentsValidator } from './arguments-validator.js';
import { ConnectorGatewayError } from './errors.js';
import type { ConnectorAuditEvent, ConnectorGatewayOptions } from './internal-contracts.js';

const CONNECTOR_PROVIDER = /^[a-z0-9_-]{1,64}$/u;
const CONNECTOR_INVOCATION_ID_MAX_BYTES = 256;
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;

type ConnectorAuthState = 'pending' | 'authenticated' | 'logged_out';

interface CapturedConnectorAuthContext {
  readonly state: ConnectorAuthState;
  readonly credential?: ConnectorCredentialSnapshot;
}

interface ToolGrant {
  readonly principalEpoch: number;
  readonly inventoryRevision: number;
  readonly descriptor: ConnectedConnectorTool;
  readonly callerBinding: HostProcessConnectorCaller;
  readonly argumentsValidator: ReturnType<typeof compileConnectorArgumentsValidator>;
}

interface InFlightCall {
  readonly controller: AbortController;
  readonly hostAdmission: HostCallAdmission;
}

interface HostProcessSlot {
  released: boolean;
  readonly activeCalls: Set<InFlightCall>;
  toolHandles: Map<string, ConnectorToolHandle>;
  currentListToken?: object;
  inventoryRevision?: number;
}

interface HostListAdmission {
  readonly caller: HostProcessConnectorCaller;
  readonly key: string;
  readonly slot: HostProcessSlot;
  readonly listToken: object;
}

interface HostCallAdmission {
  readonly caller: HostProcessConnectorCaller;
  readonly key: string;
  readonly slot: HostProcessSlot;
  readonly inventoryRevision: number;
}

export class HostConnectorGateway implements HostProcessConnectorGateway {
  private readonly grants = new WeakMap<object, ToolGrant>();
  private readonly inFlight = new Set<InFlightCall>();
  private readonly pending = new Set<Promise<void>>();
  private readonly nowMs: () => number;
  private readonly drainTimeoutMs: number;
  private principalEpoch = 0;
  private inventoryRevision = 0;
  private credential: ConnectorCredentialSnapshot | undefined;
  private epochController = new AbortController();
  private readonly terminalAudits = new Set<Promise<void>>();
  private readonly hostProcessSlots = new Map<string, HostProcessSlot>();
  private readonly registeredHostProcessKeys = new Set<string>();
  private readonly releasedHostProcessKeys = new Set<string>();
  private hasSettledAuthContext: boolean;
  private settledPrincipalId: string | undefined;
  private closed = false;

  constructor(private readonly options: ConnectorGatewayOptions) {
    this.nowMs = options.nowMs ?? Date.now;
    this.drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    const authContext = captureAuthContext(options.credentialGetter());
    this.credential = authContext.credential;
    this.hasSettledAuthContext = authContext.state !== 'pending';
    this.settledPrincipalId = authContext.credential?.realUserID;
  }

  registerHostProcess(input: {
    readonly pluginId: string;
    readonly processGeneration: string;
  }): void {
    this.assertOpen();
    const caller = captureHostProcessCaller({ kind: 'host-process', ...input });
    const key = hostInventoryKey(caller);
    if (this.releasedHostProcessKeys.has(key)) {
      throw new ConnectorGatewayError(
        'CONNECTOR_HOST_PROCESS_RELEASED',
        'Host process generation was already released',
        'not_dispatched',
      );
    }
    this.registeredHostProcessKeys.add(key);
  }

  async list(
    input: Parameters<HostProcessConnectorGateway['list']>[0],
  ): Promise<ConnectorInventory> {
    this.assertOpen();
    throwIfAborted(input.signal);
    const credential = this.requireCredential();
    const principalEpoch = this.principalEpoch;
    const epochSignal = this.epochController.signal;
    const allowedProviders = providerAllowlist(input.providerAllowlist);
    const hostAdmission = this.captureHostListAdmission(input.caller);
    if (allowedProviders.size === 0) {
      this.publishHostInventory(hostAdmission, ++this.inventoryRevision, new Map());
      return Object.freeze({
        tools: Object.freeze([]),
        providerFailures: Object.freeze([]),
        partial: false,
      });
    }
    const result = await this.options.client.listConnectedTools({
      credential,
      signal: combineSignals(input.signal, epochSignal),
    });
    this.assertEpochCurrent(principalEpoch, undefined, 'not_dispatched');
    this.assertHostAdmissionCurrent(hostAdmission);

    const descriptors = result.tools.filter(
      (descriptor) =>
        CONNECTOR_PROVIDER.test(descriptor.provider) && allowedProviders.has(descriptor.provider),
    );
    const providerFailures = result.providerFailures
      .filter(
        (failure) =>
          CONNECTOR_PROVIDER.test(failure.provider) && allowedProviders.has(failure.provider),
      )
      .map((failure) => ({
        provider: failure.provider,
        code: failure.code,
        ...(failure.retryable === undefined ? {} : { retryable: failure.retryable }),
      }));
    const inventoryRevision = ++this.inventoryRevision;
    const tools: ConnectorInventoryTool[] = [];
    const preparedGrants: Array<readonly [ConnectorToolHandle, ToolGrant]> = [];
    const hostToolHandles = new Map<string, ConnectorToolHandle>();
    for (const descriptor of descriptors) {
      const handle = this.hostToolHandleForRefresh(hostAdmission, hostToolHandles, descriptor);
      preparedGrants.push([
        handle,
        {
          principalEpoch,
          inventoryRevision,
          descriptor,
          callerBinding: hostAdmission.caller,
          argumentsValidator: compileConnectorArgumentsValidator(descriptor.inputSchemaJson),
        },
      ]);
      tools.push(Object.freeze({ ...descriptor, handle }));
    }
    this.assertHostAdmissionCurrent(hostAdmission);
    for (const [handle, grant] of preparedGrants) this.grants.set(handle, grant);
    this.publishHostInventory(hostAdmission, inventoryRevision, hostToolHandles);
    return Object.freeze({
      tools: Object.freeze(tools),
      providerFailures: Object.freeze(providerFailures),
      partial: result.partial || providerFailures.length > 0,
    });
  }

  async call(input: {
    readonly handle: ConnectorToolHandle;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly caller: HostProcessConnectorCaller;
    readonly hostRequest: ConnectorHostRequestContext;
    readonly signal?: AbortSignal;
  }): Promise<CallConnectorToolResult> {
    const completion = deferredCompletion();
    this.pending.add(completion.promise);
    try {
      return await this.performCall(input);
    } finally {
      this.pending.delete(completion.promise);
      completion.resolve();
    }
  }

  authContextChanged(): void {
    if (this.closed) return;
    const authContext = captureAuthContext(this.options.credentialGetter());
    this.principalEpoch += 1;
    const oldController = this.epochController;
    this.epochController = new AbortController();
    this.credential = authContext.credential;
    oldController.abort();
    for (const call of this.inFlight.values()) call.controller.abort();
    this.revokeHostProcessSlots();
    if (authContext.state === 'pending') return;

    const nextPrincipalId = authContext.credential?.realUserID;
    if (this.hasSettledAuthContext && nextPrincipalId !== this.settledPrincipalId) {
      this.releaseRegisteredHostProcesses();
    }
    this.hasSettledAuthContext = true;
    this.settledPrincipalId = nextPrincipalId;
  }

  releaseHostProcess(input: {
    readonly pluginId: string;
    readonly processGeneration: string;
  }): void {
    if (this.closed) return;
    const key = hostInventoryKey({ kind: 'host-process', ...input });
    this.releasedHostProcessKeys.add(key);
    this.registeredHostProcessKeys.delete(key);
    const slot = this.hostProcessSlots.get(key);
    if (!slot) return;
    this.releaseHostProcessSlot(slot);
    this.hostProcessSlots.delete(key);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.principalEpoch += 1;
    this.epochController.abort();
    for (const call of this.inFlight) call.controller.abort();
    this.revokeHostProcessSlots();
    this.registeredHostProcessKeys.clear();
    this.releasedHostProcessKeys.clear();
    const deadlineMs = performance.now() + this.drainTimeoutMs;
    await drainWithin([...this.pending], remainingMs(deadlineMs));
    await drainWithin([...this.terminalAudits], remainingMs(deadlineMs));
  }

  private async performCall(input: {
    readonly handle: ConnectorToolHandle;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly caller: HostProcessConnectorCaller;
    readonly hostRequest: ConnectorHostRequestContext;
    readonly signal?: AbortSignal;
  }): Promise<CallConnectorToolResult> {
    this.assertOpen();
    throwIfAborted(input.signal);
    const grant = this.grants.get(input.handle as object);
    if (!grant) {
      throw new ConnectorGatewayError(
        'CONNECTOR_TOOL_HANDLE_INVALID',
        'Connector tool handle is invalid',
        'not_dispatched',
      );
    }
    this.assertEpochCurrent(grant.principalEpoch, undefined, 'not_dispatched');
    assertCallerBinding(grant.callerBinding, input.caller);
    const hostAdmission = this.captureHostCallAdmission(grant, input.caller);
    const credential = this.requireCredential();
    const invocationId = invocationIdForCall(input.hostRequest);
    const clientRequestId = input.hostRequest.clientRequestId;
    const startedAtMs = this.nowMs();
    const controller = new AbortController();
    const signal = combineSignals(input.signal, this.epochController.signal, controller.signal);
    const activeCall: InFlightCall = { controller, hostAdmission };
    this.inFlight.add(activeCall);
    hostAdmission.slot.activeCalls.add(activeCall);
    let dispatched = false;
    let terminalAuditRecorded = false;

    try {
      await this.recordAdmission({
        phase: 'admission',
        timestampMs: startedAtMs,
        invocationId,
        principalEpoch: grant.principalEpoch,
        inventoryRevision: grant.inventoryRevision,
        callerKind: 'host-process',
        ...hostProcessAuditFields(hostAdmission.caller, clientRequestId),
        provider: grant.descriptor.provider,
        tool: grant.descriptor.providerToolName,
        outcome: 'not_dispatched',
      });
      this.assertEpochCurrent(grant.principalEpoch, invocationId, 'not_dispatched');
      this.assertHostCallDispatchCurrent(hostAdmission, invocationId);
      throwIfAborted(signal, invocationId);
      const validationIssues = grant.argumentsValidator?.validate(input.arguments);
      if (validationIssues) {
        throw new ConnectorGatewayError(
          'CONNECTOR_ARGUMENTS_INVALID',
          'Connector arguments are invalid',
          'not_dispatched',
          {
            invocationId,
            diagnostic: Object.freeze({ issues: validationIssues }),
          },
        );
      }
      const result = await this.options.client.callTool({
        credential,
        provider: grant.descriptor.provider,
        providerToolName: grant.descriptor.providerToolName,
        runtimeToolName: grant.descriptor.runtimeToolName,
        arguments: input.arguments,
        requestId: invocationId,
        signal,
        onDispatch: () => {
          dispatched = true;
          this.assertHostCallCurrent(hostAdmission, invocationId, 'unknown_after_dispatch');
        },
      });
      this.assertEpochCurrent(grant.principalEpoch, invocationId, 'unknown_after_dispatch');
      this.assertHostCallCurrent(hostAdmission, invocationId, 'unknown_after_dispatch');
      await this.recordTerminal(
        auditTerminal({
          grant,
          callerKind: 'host-process',
          ...hostProcessAuditFields(hostAdmission.caller, clientRequestId),
          invocationId,
          startedAtMs,
          finishedAtMs: this.nowMs(),
          outcome: result.isError === true ? 'provider_reported' : 'completed',
        }),
      );
      terminalAuditRecorded = true;
      this.assertEpochCurrent(grant.principalEpoch, invocationId, 'unknown_after_dispatch');
      this.assertHostCallCurrent(hostAdmission, invocationId, 'unknown_after_dispatch');
      return result;
    } catch (error) {
      let normalized: ConnectorGatewayError;
      try {
        const outcome = dispatched ? 'unknown_after_dispatch' : 'not_dispatched';
        this.assertEpochCurrent(grant.principalEpoch, invocationId, outcome);
        this.assertHostCallCurrent(hostAdmission, invocationId, outcome);
        normalized = normalizeCallError(error, dispatched, invocationId);
      } catch (fenceError) {
        normalized = normalizeCallError(fenceError, dispatched, invocationId);
      }
      if (!terminalAuditRecorded) {
        await this.recordTerminal(
          auditTerminal({
            grant,
            callerKind: 'host-process',
            ...hostProcessAuditFields(hostAdmission.caller, clientRequestId),
            invocationId,
            startedAtMs,
            finishedAtMs: this.nowMs(),
            outcome: normalized.outcome,
            code: normalized.code,
          }),
        );
        const outcome = dispatched ? 'unknown_after_dispatch' : 'not_dispatched';
        this.assertEpochCurrent(grant.principalEpoch, invocationId, outcome);
        this.assertHostCallCurrent(hostAdmission, invocationId, outcome);
      }
      throw normalized;
    } finally {
      hostAdmission.slot.activeCalls.delete(activeCall);
      this.inFlight.delete(activeCall);
    }
  }

  private requireCredential(): ConnectorCredentialSnapshot {
    if (this.credential) return this.credential;
    throw new ConnectorGatewayError(
      'AUTH_REQUIRED',
      'Connector access requires login',
      'not_dispatched',
    );
  }

  private captureHostListAdmission(caller: HostProcessConnectorCaller): HostListAdmission {
    const capturedCaller = captureHostProcessCaller(caller);
    const key = hostInventoryKey(capturedCaller);
    if (this.releasedHostProcessKeys.has(key)) {
      throw new ConnectorGatewayError(
        'CONNECTOR_HOST_PROCESS_RELEASED',
        'Host process generation was already released',
        'not_dispatched',
      );
    }
    if (!this.registeredHostProcessKeys.has(key)) {
      throw new ConnectorGatewayError(
        'CONNECTOR_HOST_PROCESS_NOT_REGISTERED',
        'Host process generation was not registered',
        'not_dispatched',
      );
    }
    let slot = this.hostProcessSlots.get(key);
    if (!slot || slot.released) {
      slot = { released: false, activeCalls: new Set(), toolHandles: new Map() };
      this.hostProcessSlots.set(key, slot);
    }
    const listToken = {};
    slot.currentListToken = listToken;
    return { caller: capturedCaller, key, slot, listToken };
  }

  private publishHostInventory(
    admission: HostListAdmission,
    inventoryRevision: number,
    toolHandles: Map<string, ConnectorToolHandle>,
  ): void {
    this.assertHostAdmissionCurrent(admission);
    admission.slot.toolHandles = toolHandles;
    admission.slot.inventoryRevision = inventoryRevision;
  }

  private hostToolHandleForRefresh(
    admission: HostListAdmission,
    nextHandles: Map<string, ConnectorToolHandle>,
    descriptor: ConnectedConnectorTool,
  ): ConnectorToolHandle {
    const identity = connectorToolIdentity(descriptor);
    const reusable = nextHandles.has(identity)
      ? undefined
      : admission.slot.toolHandles.get(identity);
    const handle = reusable ?? (Object.freeze({}) as ConnectorToolHandle);
    nextHandles.set(identity, handle);
    return handle;
  }

  private assertHostAdmissionCurrent(admission: HostListAdmission): void {
    const current = this.hostProcessSlots.get(admission.key);
    if (
      current === admission.slot &&
      !admission.slot.released &&
      admission.slot.currentListToken === admission.listToken
    ) {
      return;
    }
    throw new ConnectorGatewayError(
      'CONNECTOR_HOST_PROCESS_RELEASED',
      'Host process was released before Connector inventory publication',
      'not_dispatched',
    );
  }

  private revokeHostProcessSlots(): void {
    for (const slot of this.hostProcessSlots.values()) {
      this.releaseHostProcessSlot(slot);
    }
    this.hostProcessSlots.clear();
  }

  private releaseRegisteredHostProcesses(): void {
    for (const key of this.registeredHostProcessKeys) this.releasedHostProcessKeys.add(key);
    this.registeredHostProcessKeys.clear();
  }

  private captureHostCallAdmission(
    grant: ToolGrant,
    caller: HostProcessConnectorCaller,
  ): HostCallAdmission {
    const capturedCaller = captureHostProcessCaller(caller);
    const key = hostInventoryKey(capturedCaller);
    const slot = this.hostProcessSlots.get(key);
    if (!slot?.released && slot?.inventoryRevision === grant.inventoryRevision) {
      return { caller: capturedCaller, key, slot, inventoryRevision: grant.inventoryRevision };
    }
    throw new ConnectorGatewayError(
      'CONNECTOR_TOOL_HANDLE_INVALID',
      'Connector tool handle is stale for this Host inventory',
      'not_dispatched',
    );
  }

  private assertHostCallDispatchCurrent(admission: HostCallAdmission, invocationId: string): void {
    this.assertHostCallCurrent(admission, invocationId, 'not_dispatched');
    if (admission.slot.inventoryRevision === admission.inventoryRevision) return;
    throw new ConnectorGatewayError(
      'CONNECTOR_TOOL_HANDLE_INVALID',
      'Connector tool handle is stale for this Host inventory',
      'not_dispatched',
      invocationId,
    );
  }

  private assertHostCallCurrent(
    admission: HostCallAdmission,
    invocationId: string,
    outcome: ConnectorCallOutcome,
  ): void {
    if (this.hostProcessSlots.get(admission.key) === admission.slot && !admission.slot.released) {
      return;
    }
    throw new ConnectorGatewayError(
      'CONNECTOR_HOST_PROCESS_RELEASED',
      'Host process was released before the Connector call could be published',
      outcome,
      invocationId,
    );
  }

  private releaseHostProcessSlot(slot: HostProcessSlot): void {
    slot.released = true;
    for (const call of slot.activeCalls) call.controller.abort();
    slot.toolHandles.clear();
    slot.inventoryRevision = undefined;
    slot.currentListToken = undefined;
  }

  private assertEpochCurrent(
    expected: number,
    invocationId: string | undefined,
    outcome: ConnectorCallOutcome,
  ): void {
    if (expected === this.principalEpoch && !this.closed) return;
    throw new ConnectorGatewayError(
      'CONNECTOR_PRINCIPAL_CHANGED',
      'Connector principal changed before the result could be published',
      outcome,
      invocationId,
    );
  }

  private assertOpen(): void {
    if (!this.closed) return;
    throw new ConnectorGatewayError(
      'CONNECTOR_GATEWAY_CLOSED',
      'Connector gateway is closed',
      'not_dispatched',
    );
  }

  private async recordAdmission(event: ConnectorAuditEvent): Promise<void> {
    try {
      await this.options.audit?.record(event);
    } catch {
      throw new ConnectorGatewayError(
        'CONNECTOR_AUDIT_UNAVAILABLE',
        'Connector audit is unavailable',
        'not_dispatched',
        event.invocationId,
      );
    }
  }

  private async recordTerminal(event: ConnectorAuditEvent): Promise<void> {
    const operation = this.observeTerminalAudit(event);
    this.terminalAudits.add(operation);
    try {
      await operation;
    } finally {
      this.terminalAudits.delete(operation);
    }
  }

  private async observeTerminalAudit(event: ConnectorAuditEvent): Promise<void> {
    try {
      await this.options.audit?.record(event);
    } catch (error) {
      this.options.onAuditFailure?.(error);
    }
  }
}

function captureAuthContext(
  value:
    | {
        readonly accessToken?: string;
        readonly realUserID?: string;
        readonly authState?: ConnectorAuthState;
      }
    | undefined,
): CapturedConnectorAuthContext {
  const accessToken = value?.accessToken?.trim();
  const realUserID = value?.realUserID?.trim();
  const credential =
    accessToken && realUserID ? Object.freeze({ accessToken, realUserID }) : undefined;
  if (value?.authState === 'pending' || (value?.authState === 'authenticated' && !credential)) {
    return { state: 'pending' };
  }
  if (value?.authState === 'logged_out' || !credential) return { state: 'logged_out' };
  return { state: 'authenticated', credential };
}

function providerAllowlist(allowlist: readonly string[]): ReadonlySet<string> {
  const providers = new Set<string>();
  for (const provider of allowlist) {
    if (!CONNECTOR_PROVIDER.test(provider)) {
      throw new ConnectorGatewayError(
        'CONNECTOR_PROVIDER_POLICY_INVALID',
        'Connector provider policy is invalid',
        'not_dispatched',
      );
    }
    providers.add(provider);
  }
  return providers;
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return present.length === 1 ? (present[0] as AbortSignal) : AbortSignal.any(present);
}

function throwIfAborted(signal?: AbortSignal, invocationId?: string): void {
  if (!signal?.aborted) return;
  throw new ConnectorGatewayError(
    'REQUEST_ABORTED',
    'Connector request was aborted',
    'not_dispatched',
    invocationId,
  );
}

function normalizeCallError(
  error: unknown,
  dispatched: boolean,
  invocationId: string,
): ConnectorGatewayError {
  if (error instanceof ConnectorGatewayError) return error;
  return new ConnectorGatewayError(
    'CONNECTOR_CALL_FAILED',
    'Connector call failed',
    dispatched ? 'unknown_after_dispatch' : 'not_dispatched',
    invocationId,
  );
}

function auditTerminal(input: {
  readonly grant: ToolGrant;
  readonly callerKind: ConnectorAuditEvent['callerKind'];
  readonly pluginId?: string;
  readonly processGeneration?: string;
  readonly clientRequestId?: string;
  readonly invocationId: string;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly outcome: ConnectorCallOutcome;
  readonly code?: string;
}): ConnectorAuditEvent {
  return {
    phase: 'terminal',
    timestampMs: input.finishedAtMs,
    invocationId: input.invocationId,
    principalEpoch: input.grant.principalEpoch,
    inventoryRevision: input.grant.inventoryRevision,
    callerKind: input.callerKind,
    ...(input.pluginId ? { pluginId: input.pluginId } : {}),
    ...(input.processGeneration ? { processGeneration: input.processGeneration } : {}),
    ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
    provider: input.grant.descriptor.provider,
    tool: input.grant.descriptor.providerToolName,
    outcome: input.outcome,
    ...(input.code ? { code: input.code } : {}),
    durationMs: Math.max(0, input.finishedAtMs - input.startedAtMs),
  };
}

function assertCallerBinding(
  binding: HostProcessConnectorCaller,
  caller: HostProcessConnectorCaller,
): void {
  if (
    caller.pluginId === binding.pluginId &&
    caller.processGeneration === binding.processGeneration
  ) {
    return;
  }
  throw new ConnectorGatewayError(
    'CONNECTOR_TOOL_HANDLE_INVALID',
    'Connector tool handle is invalid for this caller',
    'not_dispatched',
  );
}

function invocationIdForCall(hostRequest: ConnectorHostRequestContext): string {
  if (!isBoundedInvocationId(hostRequest.clientRequestId)) {
    throw new ConnectorGatewayError(
      'CONNECTOR_CLIENT_REQUEST_ID_INVALID',
      'Connector client request id is invalid',
      'not_dispatched',
    );
  }
  return requireBoundedInvocationId(hostRequest.invocationId);
}

function requireBoundedInvocationId(invocationId: unknown): string {
  if (!isBoundedInvocationId(invocationId)) {
    throw new ConnectorGatewayError(
      'CONNECTOR_INVOCATION_ID_INVALID',
      'Connector invocation id is invalid',
      'not_dispatched',
    );
  }
  return invocationId;
}

function isBoundedInvocationId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value) <= CONNECTOR_INVOCATION_ID_MAX_BYTES
  );
}

function hostInventoryKey(caller: HostProcessConnectorCaller): string {
  return JSON.stringify([caller.pluginId, caller.processGeneration]);
}

function captureHostProcessCaller(caller: HostProcessConnectorCaller): HostProcessConnectorCaller {
  return Object.freeze({
    kind: 'host-process',
    pluginId: caller.pluginId,
    processGeneration: caller.processGeneration,
  });
}

function connectorToolIdentity(descriptor: ConnectedConnectorTool): string {
  return JSON.stringify([
    descriptor.provider,
    descriptor.providerToolName,
    descriptor.runtimeToolName,
  ]);
}

function hostProcessAuditFields(
  caller: HostProcessConnectorCaller,
  clientRequestId: string,
): Pick<ConnectorAuditEvent, 'pluginId' | 'processGeneration' | 'clientRequestId'> {
  return {
    pluginId: caller.pluginId,
    processGeneration: caller.processGeneration,
    clientRequestId,
  };
}

async function drainWithin(pending: readonly Promise<void>[], timeoutMs: number): Promise<void> {
  if (pending.length === 0 || timeoutMs <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(pending),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
}

function remainingMs(deadlineMs: number): number {
  return Math.max(0, deadlineMs - performance.now());
}

function deferredCompletion(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
