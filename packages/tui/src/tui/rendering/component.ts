import { type Component as PiComponent } from '../engine/public.js';

export { CURSOR_MARKER, type Focusable } from '../engine/public.js';

export interface Component extends PiComponent {
  dispose?(): void;
}

const disposedComponents = new WeakSet<Component>();

export function disposeComponents(...components: Array<Component | undefined>): void {
  for (const component of components) {
    if (!component || disposedComponents.has(component)) continue;
    disposedComponents.add(component);
    component.dispose?.();
  }
}
