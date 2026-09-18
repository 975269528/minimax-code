/** Node-runtime authority for product-reserved and active MiniApp loopback ports. */
export class HostMiniAppPortRegistry {
  private readonly owners = new Map<
    number,
    { readonly pluginId: string; readonly processGeneration: string }
  >();

  constructor(private readonly productReserved: ReadonlySet<number> = new Set()) {}

  isReserved(input: { readonly pluginId: string; readonly port: number }): boolean {
    return this.productReserved.has(input.port) || this.owners.has(input.port);
  }

  reserve(input: {
    readonly pluginId: string;
    readonly port: number;
    readonly processGeneration: string;
  }): { release(): void } | undefined {
    if (this.productReserved.has(input.port) || this.owners.has(input.port)) return undefined;
    const owner = Object.freeze({
      pluginId: input.pluginId,
      processGeneration: input.processGeneration,
    });
    this.owners.set(input.port, owner);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        if (this.owners.get(input.port) === owner) this.owners.delete(input.port);
      },
    };
  }
}
