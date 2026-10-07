import { useState } from "react";

type PasswordFieldProps = {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  autoComplete?: string;
  minLength?: number;
};

/** Labeled password input with a show/hide visibility toggle. The input's
 *  `name` matches its `id` so form actions can read it via FormData. */
export function PasswordField({
  id,
  label,
  value,
  onChange,
  disabled,
  autoComplete,
  minLength,
}: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
  const toggleLabel = visible ? `Hide ${label}` : `Show ${label}`;

  return (
    <div className="form-group">
      <label htmlFor={id}>{label}</label>
      <div className="password-field">
        <input
          id={id}
          name={id}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required
          disabled={disabled}
          minLength={minLength}
          autoComplete={autoComplete}
        />
        <button
          type="button"
          className="password-toggle"
          aria-label={toggleLabel}
          onClick={() => setVisible((current) => !current)}
          disabled={disabled}
        >
          {visible ? (
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
              <path
                d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M1 1l22 22"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
              <path
                d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
              <path
                d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
