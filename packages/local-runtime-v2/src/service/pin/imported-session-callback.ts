interface ImportedSessionPinTarget {
  addImportedSession(sessionId: string): Promise<void>;
}

interface ImportedSessionPinCallback {
  readonly onImported: (sessionId: string) => Promise<void>;
  readonly bind: (target: ImportedSessionPinTarget) => void;
}

/** Breaks the Session-import/Pin construction cycle without ever dropping a recovered Pin. */
export function createImportedSessionPinCallback(): ImportedSessionPinCallback {
  let target: ImportedSessionPinTarget | undefined;
  return {
    onImported: async (sessionId) => {
      if (!target) throw new Error('Imported Session Pin callback is not bound');
      await target.addImportedSession(sessionId);
    },
    bind: (next) => {
      if (target) throw new Error('Imported Session Pin callback is already bound');
      target = next;
    },
  };
}
