'use client';

import { useEffect, useState } from 'react';

/** `value` after it has been stable for `ms` (search-as-you-type without a request per key). */
export function useDebounced<T>(value: T, ms = 150): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}
