import { useCallback, useState } from "react";
import { useVex } from "./provider.js";

export interface UseMutationResult<TArgs, TResult> {
  mutate: (args: TArgs) => Promise<TResult>;
  isLoading: boolean;
  error: Error | null;
}

/**
 * One-shot mutation over the same WebSocket the live subscriptions
 * ride. The promise resolves with whatever the server's mutation
 * handler returned (typically a row id). Errors surface both via
 * the rejected promise and the `error` state, so consumers can pick
 * either style.
 *
 * `TArgs` defaults to `Record<string, any>` to match the looser
 * generic the previous EventSource-based hook exposed — any consumer
 * with a typed args interface (`{ name: string }`) keeps compiling
 * without needing an explicit `extends Record<string, unknown>`.
 */
export function useMutation<TArgs = Record<string, any>, TResult = unknown>(
  mutationName: string,
): UseMutationResult<TArgs, TResult> {
  const { client } = useVex();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const mutate = useCallback(
    async (args: TArgs): Promise<TResult> => {
      setIsLoading(true);
      setError(null);
      try {
        return await client.mutate<TResult>(
          mutationName,
          args as Record<string, unknown>,
        );
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [client, mutationName],
  );

  return { mutate, isLoading, error };
}
