import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
} from "react";
import { VexClient } from "./client.js";

interface VexContextValue {
  client: VexClient;
}

// Initialised lazily inside the provider so consumers outside one
// fail loudly instead of getting a half-real client.
const VexContext = createContext<VexContextValue | null>(null);

export function useVex(): VexContextValue {
  const ctx = useContext(VexContext);
  if (!ctx) {
    throw new Error(
      "useVex() called outside <VexProvider>. Mount one near the root of your tree.",
    );
  }
  return ctx;
}

/**
 * Mount once near the app root. Holds the single `VexClient`
 * (and therefore the single WebSocket) for the tree below it.
 *
 * `basePath` is the mount path of the vex-core router (default
 * `/vex`). Cross-origin deployments can pass an absolute URL
 * (`https://api.example.com/vex`) and the client will derive the
 * matching `wss://` URL for the live channel.
 */
export function VexProvider({
  basePath = "/vex",
  children,
}: {
  basePath?: string;
  children: ReactNode;
}) {
  // We deliberately avoid `useMemo`/`useState` lazy-init for the
  // client: both re-run their factory under React 18 strict-mode
  // dev double-render, allocating a wasted VexClient on every
  // mount. `useRef` is the only hook whose value survives the
  // double-invoke without re-execution — the lazy `??` assignment
  // runs exactly once per component instance.
  //
  // The basePathRef pair makes the client recreate cleanly when
  // the prop changes (closing the old socket first), without
  // recreating it just because React felt like re-rendering.
  const clientRef = useRef<VexClient | null>(null);
  const basePathRef = useRef(basePath);
  if (clientRef.current === null) {
    clientRef.current = new VexClient({ basePath });
  } else if (basePathRef.current !== basePath) {
    clientRef.current.close();
    clientRef.current = new VexClient({ basePath });
    basePathRef.current = basePath;
  }
  const client = clientRef.current;

  // Tear down on unmount. Refs persist across renders, so we have
  // to clear `clientRef.current` ourselves — a remount (e.g. dev
  // hot reload) would otherwise reuse the closed client.
  useEffect(() => {
    return () => {
      clientRef.current?.close();
      clientRef.current = null;
    };
  }, []);

  return createElement(VexContext.Provider, { value: { client } }, children);
}
