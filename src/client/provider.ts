import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
} from "react";

interface VexContextValue {
  basePath: string;
}

const VexContext = createContext<VexContextValue>({ basePath: "/vex" });

export function useVex(): VexContextValue {
  return useContext(VexContext);
}

export function VexProvider({
  basePath = "/vex",
  children,
}: {
  basePath?: string;
  children: ReactNode;
}) {
  return createElement(VexContext.Provider, { value: { basePath } }, children);
}
