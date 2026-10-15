import { useEffect, useState, type ReactNode } from "react";
import { animate } from "framer-motion";

/**
 * A whole number that counts up once when it first appears. Anything else is shown as given, and
 * people who ask their system for less motion see the final number straight away.
 */
export function CountUp({ value, duration = 0.6 }: { value: ReactNode; duration?: number }) {
  const numeric = typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
  const [shown, setShown] = useState<ReactNode>(numeric ? 0 : value);

  useEffect(() => {
    if (!numeric) {
      setShown(value);
      return;
    }
    const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || value === 0) {
      setShown(value);
      return;
    }
    const controls = animate(0, value as number, {
      duration,
      ease: "easeOut",
      onUpdate: next => setShown(Math.round(next)),
      onComplete: () => setShown(value),
    });
    return () => controls.stop();
  }, [value, numeric, duration]);

  return <>{shown}</>;
}
