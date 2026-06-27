import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { commands } from '../../tauri';
import './FileEditorModal.css';

interface OpenFileDetail {
  path: string;
}

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

function parentDir(path: string): string {
  return path.replace(/[\\/][^\\/]+$/, '');
}

export function FileEditorModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [filePath, setFilePath] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [content, setContent] = useState('');
  const [status, setStatus] = useState<LoadState>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const dirty = useMemo(() => content !== originalContent, [content, originalContent]);

  const closeEditor = useCallback(() => {
    if (dirty && !window.confirm('当前文件有未保存修改，确认关闭吗？')) return;
    setIsOpen(false);
    setStatus('idle');
    setSaving(false);
    setErrorMsg('');
  }, [dirty]);

  const loadFile = useCallback(async (path: string) => {
    setIsOpen(true);
    setFilePath(path);
    setStatus('loading');
    setErrorMsg('');
    try {
      const text = await commands.readTextFile(path);
      setOriginalContent(text);
      setContent(text);
      setStatus('ready');
      setTimeout(() => textareaRef.current?.focus(), 0);
    } catch (err) {
      setOriginalContent('');
      setContent('');
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const saveFile = useCallback(async () => {
    if (!filePath || saving || !dirty) return;
    setSaving(true);
    setErrorMsg('');
    try {
      await commands.writeTextFile(filePath, content);
      setOriginalContent(content);
      window.dispatchEvent(new CustomEvent('fs-refresh', {
        detail: { dirPath: parentDir(filePath) },
      }));
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [content, dirty, filePath, saving]);

  useEffect(() => {
    const handler = (event: Event) => {
      const ev = event as CustomEvent<OpenFileDetail>;
      const nextPath = ev.detail?.path;
      if (!nextPath) return;
      if (dirty && filePath && filePath !== nextPath) {
        const ok = window.confirm('当前文件有未保存修改，是否放弃并打开新文件？');
        if (!ok) return;
      }
      void loadFile(nextPath);
    };
    window.addEventListener('coffee-open-file', handler);
    return () => window.removeEventListener('coffee-open-file', handler);
  }, [dirty, filePath, loadFile]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveFile();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeEditor();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, closeEditor, saveFile]);

  if (!isOpen) return null;

  return createPortal(
    <div className="file-editor-modal-backdrop" onMouseDown={closeEditor}>
      <div className="file-editor-modal" onMouseDown={e => e.stopPropagation()}>
        <div className="file-editor-modal__header">
          <div className="file-editor-modal__title-group">
            <div className="file-editor-modal__title">文件编辑器</div>
            <div className="file-editor-modal__path" title={filePath}>{filePath}</div>
          </div>
          <div className="file-editor-modal__actions">
            <button
              className="file-editor-modal__btn"
              onClick={() => void loadFile(filePath)}
              disabled={!filePath || status === 'loading' || saving}
            >
              重新加载
            </button>
            <button
              className="file-editor-modal__btn file-editor-modal__btn--primary"
              onClick={() => void saveFile()}
              disabled={!dirty || saving || status !== 'ready'}
            >
              {saving ? '保存中...' : dirty ? '保存' : '已保存'}
            </button>
            <button className="file-editor-modal__btn" onClick={closeEditor}>关闭</button>
          </div>
        </div>

        {status === 'loading' ? (
          <div className="file-editor-modal__state">正在读取文件...</div>
        ) : status === 'error' ? (
          <div className="file-editor-modal__state file-editor-modal__state--error">
            {errorMsg || '打开文件失败'}
          </div>
        ) : (
          <>
            <textarea
              ref={textareaRef}
              className="file-editor-modal__textarea"
              value={content}
              onChange={e => setContent(e.target.value)}
              spellCheck={false}
            />
            <div className="file-editor-modal__footer">
              <span>{dirty ? '有未保存修改' : '内容已同步到磁盘'}</span>
              <span>Ctrl/Cmd + S 保存，Esc 关闭</span>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
