import { useFormStatus } from "react-dom";

interface FormSubmitButtonProps {
  children: string;
  pendingLabel: string;
  className?: string;
}

/**
 * Submit button that reflects the pending state of the nearest React 19 form
 * action via useFormStatus: while the action is in flight the label switches
 * to `pendingLabel` and the button is disabled. Must be rendered inside the
 * <form> it belongs to (useFormStatus reads the form ancestor).
 */
export function FormSubmitButton({
  children,
  pendingLabel,
  className = "btn btn-primary",
}: FormSubmitButtonProps) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending}>
      {pending ? pendingLabel : children}
    </button>
  );
}