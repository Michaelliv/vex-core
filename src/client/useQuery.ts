import { useEffect, useState } from "react";
import { useVex } from "./provider.js";

export interface UseQueryResult<T> {
  data: T | undefined;
  error: Error | null;
  isLoading: boolean;
}

export function useQuery<T = any>(
  queryName: string,
  args: Record<string, any> = {},
): UseQueryResult<T> {
  const { basePath } = useVex();
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const argsKey = JSON.stringify(args);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setError(null);

    const params = new URLSearchParams({ name: queryName, args: argsKey });
    const es = new EventSource(`${basePath}/subscribe?${params}`);

    es.onmessage = (event) => {
      if (!active) return;
      try {
        setData(JSON.parse(event.data));
        setError(null);
        setIsLoading(false);
      } catch (_e: any) {
        setError(new Error("Failed to parse server data"));
      }
    };

    es.onerror = () => {
      if (!active) return;
      if (es.readyState === EventSource.CLOSED) {
        setError(new Error("Connection closed"));
        setIsLoading(false);
      }
    };

    return () => {
      active = false;
      es.close();
    };
  }, [basePath, queryName, argsKey]);

  return { data, error, isLoading };
}
