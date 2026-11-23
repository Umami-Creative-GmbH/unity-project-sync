import { useEffect, useRef, useState } from "react";
import { IconPower } from "@tabler/icons-react";

import { tone } from "@/components/tone";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Progress } from "@/components/ui/progress";

export const SHUTDOWN_COUNTDOWN_SECS = 60;

interface ShutdownDialogProps {
  open: boolean;
  /** Called when the user cancels (button, Escape). */
  onCancel: () => void;
  /** Called once — when the countdown reaches 0 or "Shut down now" is pressed. */
  onShutdown: () => void;
}

export function ShutdownDialog({ open, onCancel, onShutdown }: ShutdownDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onCancel()}>
      {open && <Countdown onShutdown={onShutdown} />}
    </AlertDialog>
  );
}

function Countdown({ onShutdown }: Pick<ShutdownDialogProps, "onShutdown">) {
  const [deadline] = useState(() => Date.now() + SHUTDOWN_COUNTDOWN_SECS * 1000);
  const [remaining, setRemaining] = useState(SHUTDOWN_COUNTDOWN_SECS);
  const firedRef = useRef(false);
  const shutdownRef = useRef(onShutdown);
  shutdownRef.current = onShutdown;

  const fire = () => {
    if (firedRef.current) return;
    firedRef.current = true;
    shutdownRef.current();
  };

  useEffect(() => {
    const tick = () => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRemaining(left);
      if (left <= 0) {
        window.clearInterval(id);
        if (!firedRef.current) {
          firedRef.current = true;
          shutdownRef.current();
        }
      }
    };
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [deadline]);

  return (
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogMedia className={tone.warning}>
          <IconPower />
        </AlertDialogMedia>
        <AlertDialogTitle>Shutting down in {remaining} s</AlertDialogTitle>
        <AlertDialogDescription>
          The sync finished without errors. This computer will shut down automatically — save any open work
          or cancel now.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <Progress
        value={(remaining / SHUTDOWN_COUNTDOWN_SECS) * 100}
        className="h-1.5"
        aria-label="Time until shutdown"
      />
      <AlertDialogFooter>
        {/* Closing via Cancel/Escape reaches the parent through onOpenChange → onCancel. */}
        <AlertDialogCancel autoFocus>Cancel shutdown</AlertDialogCancel>
        <AlertDialogAction
          variant="destructive"
          onClick={(e) => {
            // Keep Radix from closing the dialog (which would be reported as a cancel).
            e.preventDefault();
            fire();
          }}
        >
          Shut down now
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  );
}
