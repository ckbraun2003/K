// placeholder — replaced in Task 9
export default function CommandBar({ open, onClose }: { open: boolean; onClose: () => void }) {
  return open ? <div className="fixed inset-0 z-50" onClick={onClose} /> : null
}
