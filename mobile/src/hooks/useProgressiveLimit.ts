import { useEffect, useState } from "react";

export function useProgressiveLimit(resetKey: string, batchSize = 20) {
  const [limit, setLimit] = useState(batchSize);

  useEffect(() => {
    setLimit(batchSize);
  }, [batchSize, resetKey]);

  return {
    limit,
    showMore: () => setLimit((current) => current + batchSize),
  };
}
