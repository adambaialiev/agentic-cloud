/** The same model door in the agent header and the private overview. */
export function HeadRuntimeButton({ text, onClick, id, subject }: { text: string; onClick: () => void; id?: string; subject?: string }) {
  return <button className="sub headruntime" id={id} type="button"
    aria-label={`Choose ${subject ? `${subject} ` : ''}model and effort. Current: ${text}`} onClick={onClick}>
    <span>{text}</span>
  </button>;
}
