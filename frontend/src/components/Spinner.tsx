import "./Spinner.css";

interface SpinnerProps {
  size?: number;
  label?: string;
}

export function Spinner({ size = 20, label = "Loading" }: SpinnerProps) {
  return (
    <span
      className="spinner"
      role="status"
      aria-label={label}
      style={{ width: size, height: size }}
    >
      <span className="sr-only">{label}</span>
    </span>
  );
}