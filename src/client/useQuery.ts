import { useEffect, useState } from "react";
import { useVex } from "./provider.js";

export interface UseQueryResult<T> {
  data: T | undefined;
  error: Error | null;
  isLoading: boolean;
}

/**
 * Subscribe to a live query. The component re-renders on every
 * server-pushed update. Cleanup unsubscribes — no leaked engine-side
 * subscription, no duplicate frames after re-mount.
 *
 * Don't be misled by the `useQuery` name — this is a *subscription*.
 * For a one-shot read with no live updates, call `client.query()`
 * directly via `useVex().client`.
 */
export function useQuery<T = unknown>(
  queryName: string,
  args: Record<string, unknown> = {},
): UseQueryResult<T> {
  const { client } = useVex();
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Stringify once so the dep array compares by content, not by
  // object identity — `args = {}` from a parent rerender otherwise
  // looks like a fresh subscription every render.
  const argsKey = JSON.stringify(args);

  useEffect(() => {
    setIsLoading(true);
    setError(null);
    setData(undefined);

    const off = client.subscribe<T>(
      queryName,
      JSON.parse(argsKey),
      (next) => {
        setData(next);
        setError(null);
        setIsLoading(false);
      },
      (err) => {
        setError(err);
        setIsLoading(false);
      },
    );
    return off;
  }, [client, queryName, argsKey]);

  return { data, error, isLoading };
}
