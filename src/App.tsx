import { useCallback, useEffect, useRef, useState } from 'react';
import {
  bitable,
  FieldType,
  IAttachmentFieldMeta,
  IFieldMeta,
  ITable,
} from '@lark-base-open/js-sdk';
import { Phase, ProgressInfo, runDownload, RunResult } from './download';import { buildFolderName, isTemplateTooLong, NamingContext } from './naming';

type Status = 'loading' | 'ready' | 'error';

const TEMPLATE_PRESETS = [
  { label: '日期', insert: '{日期}' },
  { label: '序号', insert: '{序号}' },
  { label: '原文件名', insert: '{原文件名}' },
];

const PHASE_LABEL: Record<Phase, string> = {
  collecting: '读取记录',
  downloading: '下载附件',
  zipping: '打包 ZIP',
  done: '完成',
  error: '出错',
};

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export default function App() {
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);

  const [tableName, setTableName] = useState('');
  const [attachmentFields, setAttachmentFields] = useState<IAttachmentFieldMeta[]>([]);
  const [allFields, setAllFields] = useState<IFieldMeta[]>([]);
  const [selected, setSelected] = useState<string[]>([]);

  const [folderTemplate, setFolderTemplate] = useState('{Existing Application & info}_{Survey date}');
  const [scope, setScope] = useState<'all' | 'view'>('all');

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ProgressInfo | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [preview, setPreview] = useState<string[]>([]);

  const tableRef = useRef<ITable | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const table = await bitable.base.getActiveTable();
        tableRef.current = table;
        setTableName((await table.getName()) || '未命名数据表');
        const metas = await table.getFieldMetaListByType<IAttachmentFieldMeta>(FieldType.Attachment);
        setAttachmentFields(metas);
        setSelected(metas.map((m) => m.id));
        const all = await table.getFieldMetaList();
        setAllFields(all);
        setStatus('ready');
      } catch (e) {
        console.error(e);
        setError('插件只能在飞书多维表格中运行。请打开一个多维表格，在「插件 → 自定义插件」中添加本插件地址。');
        setStatus('error');
      }
    })();
  }, []);

  // 实时预览文件夹命名效果（读取前若干条记录）
  const refreshPreview = useCallback(async () => {
    if (!tableRef.current) return;
    try {
      const table = tableRef.current;
      const fieldIdToName: Record<string, string> = {};
      allFields.forEach((f) => (fieldIdToName[f.id] = f.name));
      const page = await table.getRecordsByPage({ pageSize: 10 });
      const date = new Date().toISOString().slice(0, 10);
      const samples: string[] = [];
      let idx = 0;
      for (const rec of page.records) {
        const fieldStrings: Record<string, string> = {};
        for (const [fid, raw] of Object.entries(rec.fields ?? {})) {
          const name = fieldIdToName[fid] ?? fid;
          fieldStrings[name] = Array.isArray(raw) ? raw.join('、') : String(raw ?? '');
        }
        // 找第一条附件用于预览
        let originalName = '';
        let firstFieldName = '';
        for (const fid of selected) {
          try {
            const f = await table.getField(fid);
            const vals = await f.getValue(rec.recordId);
            if (vals && vals.length) {
              originalName = vals[0].name;
              firstFieldName = fieldIdToName[fid] ?? fid;
              break;
            }
          } catch {
            /* 忽略 */
          }
        }
        if (!originalName) continue;
        const ctx: NamingContext = {
          fieldValues: fieldStrings,
          originalName,
          index: ++idx,
          date,
        };
        samples.push(`${buildFolderName(folderTemplate, ctx)}  / ${firstFieldName}_1`);
        if (samples.length >= 5) break;
      }
      setPreview(samples);
    } catch {
      setPreview([]);
    }
  }, [selected, folderTemplate, allFields]);

  const toggleField = (id: string) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const insertToken = (token: string) => {
    setFolderTemplate((prev) => prev + token);
  };

  const insertFieldToken = (name: string) => {
    setFolderTemplate((prev) => prev + `{${name}}`);
  };

  const handleDownload = async () => {
    if (running) return;
    if (!selected.length) {
      setError('请至少选择一个附件字段');
      return;
    }
    if (isTemplateTooLong(folderTemplate)) {
      setError('文件夹命名模板过长，请控制在 200 字符以内');
      return;
    }
    setRunning(true);
    setResult(null);
    setPreview([]);
    setError(null);
    try {
      const res = await runDownload(selected, folderTemplate, scope, (p) => {
        setProgress(p);
      });
      setResult(res);
    } catch (e) {
      setError((e as Error).message || '下载失败');
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  const percent = progress && progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;
  const nameableFields = allFields.filter(
    (f) => f.type !== FieldType.Attachment && f.type !== FieldType.Checkbox && f.type !== FieldType.AutoNumber
  );

  return (
    <div className="wrap">
      <header className="header">
        <div className="title">附件批量下载</div>
        <div className="subtitle">按自定义规则重命名并打包 ZIP</div>
      </header>

      {status === 'loading' && <div className="hint">正在连接数据表…</div>}

      {status === 'error' && (
        <div className="alert error">{error}</div>
      )}

      {status === 'ready' && (
        <>
          <section className="card">
            <div className="card-title">
              1. 选择附件字段 <span className="muted">当前表：{tableName}</span>
            </div>
            {attachmentFields.length === 0 ? (
              <div className="muted">当前数据表没有附件字段。</div>
            ) : (
              <div className="field-list">
                {attachmentFields.map((f) => (
                  <label key={f.id} className="check">
                    <input
                      type="checkbox"
                      checked={selected.includes(f.id)}
                      onChange={() => toggleField(f.id)}
                    />
                    <span className="check-text">{f.name}</span>
                  </label>
                ))}
              </div>
            )}
          </section>

          <section className="card">
            <div className="card-title">2. 文件夹命名规则</div>
            <div className="hint small">
              每条记录单独一个文件夹，用字段值命名。非法字符（如 /）自动替换为 -
            </div>
            <input
              className="input"
              value={folderTemplate}
              onChange={(e) => setFolderTemplate(e.target.value)}
              placeholder="如 {Existing Application & info}_{Survey date}"
            />
            <div className="token-row">
              {TEMPLATE_PRESETS.map((p) => (
                <button key={p.label} className="chip" onClick={() => insertToken(p.insert)}>
                  {p.label}
                </button>
              ))}
            </div>
            {nameableFields.length > 0 && (
              <div className="token-row">
                <span className="muted small">字段变量：</span>
                {nameableFields.slice(0, 12).map((f) => (
                  <button key={f.id} className="chip" onClick={() => insertFieldToken(f.name)}>
                    {f.name}
                  </button>
                ))}
              </div>
            )}
            <div className="hint small">
              示例：{'{Existing Application & info}_{Survey date}'} → APP123_2026-09-24
            </div>
            <div className="hint small">
              附件命名固定为：所在字段名称_序号（如 附件A_1.jpg、附件A_2.png）
            </div>
            <button className="btn ghost" onClick={refreshPreview} disabled={running}>
              预览文件夹名（前 5 条）
            </button>
            {preview.length > 0 && (
              <ul className="preview">
                {preview.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            )}
          </section>

          <section className="card">
            <div className="card-title">3. 记录范围</div>
            <label className="check">
              <input type="radio" name="scope" checked={scope === 'all'} onChange={() => setScope('all')} />
              <span className="check-text">全部记录</span>
            </label>
            <label className="check">
              <input type="radio" name="scope" checked={scope === 'view'} onChange={() => setScope('view')} />
              <span className="check-text">当前视图（可见记录）</span>
            </label>
          </section>

          <button className="btn primary" onClick={handleDownload} disabled={running || !selected.length}>
            {running ? '处理中…' : '一键下载并打包 ZIP'}
          </button>

          {running && progress && (
            <div className="progress-wrap">
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${percent}%` }} />
              </div>
              <div className="progress-text">
                {PHASE_LABEL[progress.phase]}：{progress.processed}/{progress.total}
                {progress.message ? ` · ${progress.message}` : ''}
              </div>
            </div>
          )}

          {error && <div className="alert error">{error}</div>}

          {result && (
            <div className="alert ok">
              <div className="ok-line">
                已打包 <b>{result.itemCount}</b> 个附件（约 {formatBytes(result.totalBytes)}），
                生成 <b>{result.folderCount}</b> 个文件夹、涉及{' '}
                <b>{result.recordCount}</b> 条记录 → <b>{result.zipName}</b>
              </div>
              {Object.keys(result.countByField).length > 0 && (
                <div className="ok-line small">
                  {Object.entries(result.countByField)
                    .filter(([, c]) => c > 0)
                    .map(([fid, c]) => `${fid}: ${c}`)
                    .join('、')}
                </div>
              )}
              {result.failed.length > 0 && (
                <div className="failed">
                  <div className="failed-title">以下 {result.failed.length} 个文件下载失败：</div>
                  {result.failed.map((m, i) => (
                    <div key={i} className="failed-item">
                      {m}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="foot">
            <a
              href="https://open.feishu.cn/document/base-extensions/base-extension-introduction"
              target="_blank"
              rel="noreferrer"
            >
              飞书插件开发文档
            </a>
            <span className="muted">· 请仅下载有权限访问的表格数据</span>
          </div>
        </>
      )}
    </div>
  );
}
