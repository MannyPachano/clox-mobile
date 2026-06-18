import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { markTutorialComplete } from "../api";
import { getAccessToken } from "../supabase";
import { buildSteps, type TutorialStep } from "./steps";

export type Rect = { x: number; y: number; width: number; height: number };

/** Anything with measureInWindow — RN host refs (View, TouchableOpacity, …). */
type Measurable = {
  measureInWindow: (
    cb: (x: number, y: number, width: number, height: number) => void,
  ) => void;
};

type TutorialContextValue = {
  active: boolean;
  step: TutorialStep | null;
  stepIndex: number;
  stepCount: number;
  start: () => void;
  next: () => void;
  back: () => void;
  skip: () => void;
  registerTarget: (key: string, node: Measurable | null) => void;
  measureActive: () => Promise<Rect | null>;
};

const TutorialCtx = createContext<TutorialContextValue | null>(null);

export function useTutorial(): TutorialContextValue {
  const v = useContext(TutorialCtx);
  if (!v) throw new Error("useTutorial must be used within a TutorialProvider");
  return v;
}

/** Returns a ref callback to attach to a target so the tour can spotlight it. */
export function useTutorialTarget(key: string) {
  const { registerTarget } = useTutorial();
  return useCallback(
    (node: Measurable | null) => registerTarget(key, node),
    [registerTarget, key],
  );
}

export function TutorialProvider({
  role,
  autoStart,
  children,
}: {
  role: string;
  autoStart: boolean;
  children: ReactNode;
}) {
  const steps = useMemo(() => buildSteps(role), [role]);
  const [active, setActive] = useState(() => autoStart && steps.length > 0);
  const [index, setIndex] = useState(0);
  const targets = useRef<Map<string, Measurable | null>>(new Map());

  const registerTarget = useCallback((key: string, node: Measurable | null) => {
    targets.current.set(key, node);
  }, []);

  const markDone = useCallback(() => {
    void getAccessToken().then((t) => {
      if (t) void markTutorialComplete(t);
    });
  }, []);

  const skip = useCallback(() => {
    setActive(false);
    setIndex(0);
    markDone();
  }, [markDone]);

  const next = useCallback(() => {
    if (index + 1 >= steps.length) {
      setActive(false);
      setIndex(0);
      markDone();
    } else {
      setIndex(index + 1);
    }
  }, [index, steps.length, markDone]);

  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  const start = useCallback(() => {
    setIndex(0);
    setActive(true);
  }, []);

  const measureActive = useCallback(() => {
    const step = steps[index];
    const node = step?.targetKey
      ? targets.current.get(step.targetKey)
      : null;
    return new Promise<Rect | null>((resolve) => {
      if (!node) {
        resolve(null);
        return;
      }
      node.measureInWindow((x, y, width, height) =>
        resolve({ x, y, width, height }),
      );
    });
  }, [steps, index]);

  const value: TutorialContextValue = {
    active,
    step: steps[index] ?? null,
    stepIndex: index,
    stepCount: steps.length,
    start,
    next,
    back,
    skip,
    registerTarget,
    measureActive,
  };

  return <TutorialCtx.Provider value={value}>{children}</TutorialCtx.Provider>;
}
