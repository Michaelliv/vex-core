import { useCallback, useState } from "react";
import { useVex } from "./provider.js";

export interface UseMutationResult<TArgs, TResult> {
  mutate: (args: TArgs) => Promise<TResult>;
  isLoading: boolean;
  error: Error | null;
}

export function useMutation<TArgs = Record<string, any>, TResult = any>(
  mutationName: string,
): UseMutationResult<TArgs, TResult> {
  const { basePath } = useVex();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const mutate = useCallback(
    async (args: TArgs): Promise<TResult> => {
      setIsLoading(true);
      setError(null);
      try {
        const res = await fetch(`${basePath}/mutate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: mutationName, args }),
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || "Mutation failed");
        return result.data;
      } catch (e: any) {
        setError(e);
        throw e;
      } finally {
        setIsLoading(false);
      }
    },
    [basePath, mutationName],
  );

  return { mutate, isLoading, error };
}
