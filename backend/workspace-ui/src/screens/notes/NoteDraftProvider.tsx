import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { isInlineImage } from '../../ui/file-kind.js';
import { NoteDraftContext, type NoteDraftFile, type NoteDraftValue } from './draft-context.js';

export function NoteDraftProvider({ children }: { children: ReactNode }) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<readonly NoteDraftFile[]>([]);
  // Read on UNMOUNT only, which is why it is a ref: the cleanup must see the
  // list as it finally stood, and an effect that watched `files` would revoke
  // a live URL every time one more was picked.
  const held = useRef<readonly NoteDraftFile[]>([]);
  useEffect(() => { held.current = files; });
  useEffect(() => () => {
    for (const picked of held.current) if (picked.url) URL.revokeObjectURL(picked.url);
  }, []);

  const addFile = useCallback((file: File) => {
    // No mint and no network: the bytes are already on the phone, so a photo
    // fills the instant it is chosen rather than after a round trip.
    const url = isInlineImage(file.type) ? URL.createObjectURL(file) : null;
    setFiles((current) => [...current, { file, url }]);
  }, []);

  const removeFile = useCallback((file: File) => {
    setFiles((current) => {
      const going = current.find((picked) => picked.file === file);
      if (going?.url) URL.revokeObjectURL(going.url);
      return current.filter((picked) => picked.file !== file);
    });
  }, []);

  const clear = useCallback(() => {
    setFiles((current) => {
      for (const picked of current) if (picked.url) URL.revokeObjectURL(picked.url);
      return [];
    });
    setText('');
  }, []);

  const value = useMemo<NoteDraftValue>(
    () => ({ text, files, setText, addFile, removeFile, clear }),
    [text, files, addFile, removeFile, clear],
  );
  return <NoteDraftContext value={value}>{children}</NoteDraftContext>;
}
