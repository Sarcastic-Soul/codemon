import React, { useEffect, useState } from "react";
import { Text } from "ink";
import { SPINNER_INTERVAL_MS, spinnerFrame } from "../theme.ts";

interface PokeballSpinnerProps {
  /** Overrides the timer, so a test can assert a specific frame. */
  tick?: number;
}

/**
 * A pokéball turning on the spot.
 *
 * Hand-rolled rather than `ink-spinner` because the frames need to alternate
 * colour as well as shape: the seam sweeps red through white, which is what
 * separates a spinning ball from a blinking character. One interval, cleared on
 * unmount, so an idle session leaves no timer running.
 */
export function PokeballSpinner({ tick }: PokeballSpinnerProps) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (tick !== undefined) return; // controlled
    const timer = setInterval(() => setFrame((f) => f + 1), SPINNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [tick]);

  const index = tick ?? frame;
  // The upper half is the red shell, the lower the pale base; alternating the
  // colour with the shape keeps the rotation legible on one character.
  const color = index % 2 === 0 ? "red" : "white";

  return (
    <Text color={color} bold>
      {spinnerFrame(index)}
    </Text>
  );
}
