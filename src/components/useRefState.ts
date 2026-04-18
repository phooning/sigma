import {
  Dispatch,
  MutableRefObject,
  SetStateAction,
  useCallback,
  useRef,
  useState,
} from "react";

export function useRefState<T>(
  initialValue: T | (() => T),
): [T, MutableRefObject<T>, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState(initialValue);
  const ref = useRef(value);

  const setRefValue = useCallback<Dispatch<SetStateAction<T>>>((nextValue) => {
    setValue((previousValue) => {
      const resolvedValue =
        typeof nextValue === "function"
          ? (nextValue as (previous: T) => T)(previousValue)
          : nextValue;
      ref.current = resolvedValue;
      return resolvedValue;
    });
  }, []);

  return [value, ref, setRefValue];
}
