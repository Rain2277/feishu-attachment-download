/**
 * 数据采集与下载打包逻辑
 *
 * 流程：
 *  1. 读取当前数据表的记录（按视图范围或全部，分页），同时拿到每条记录的
 *     全部字段展示值（用于命名模板中的 {字段名} 变量）。
 *  2. 对选中的每个附件字段，读取每条记录的附件对象（token / 原始文件名 / 大小）。
 *  3. 用 getCellAttachmentUrls 换取临时下载链接，逐文件 fetch 为 Blob。
 *  4. 按命名规则重命名后写入 JSZip，最后生成 ZIP 并触发浏览器下载。
 */

import JSZip from 'jszip';
import {
  bitable,
  FieldType,
  IAttachmentField,
  IOpenAttachment,
  ITable,
} from '@lark-base-open/js-sdk';
import { buildBaseName, makeUniqueName, NamingContext } from './naming';

export interface AttachmentItem {
  originalName: string;
  token: string;
  url: string;
  size: number;
  recordId: string;
  fieldId: string;
  fieldName: string;
}

export interface CollectResult {
  items: AttachmentItem[];
  /** fieldId -> 字段名 */
  fieldNameById: Record<string, string>;
  /** fieldId -> 该字段下附件数量 */
  countByField: Record<string, number>;
  /** 至少含一个附件的记录数 */
  recordCount: number;
  /** recordId -> 各字段展示字符串（供命名） */
  fieldStrings: Record<string, Record<string, string>>;
}

export type Phase = 'collecting' | 'downloading' | 'zipping' | 'done' | 'error';

export interface ProgressInfo {
  phase: Phase;
  processed: number;
  total: number;
  message?: string;
}

/** 当前视图的可见记录 id 列表；异常时返回 null（调用方回退到全部记录） */
async function getViewRecordIds(table: ITable): Promise<string[] | null> {
  try {
    const view = await table.getActiveView();
    const ids = await view.getVisibleRecordIdList();
    return ids.filter((id): id is string => typeof id === 'string');
  } catch {
    return null;
  }
}

/** 分页读取全部记录，返回 recordId -> 各字段展示字符串 */
async function readAllFieldStrings(
  table: ITable
): Promise<Record<string, Record<string, string>>> {
  const fieldStrings: Record<string, Record<string, string>> = {};
  let pageToken: string | number | undefined;
  do {
    const page = await table.getRecordsByPage({ pageSize: 200, pageToken: pageToken as never });
    for (const rec of page.records) {
      const strings: Record<string, string> = {};
      for (const [fid, raw] of Object.entries(rec.fields ?? {})) {
        strings[fid] = Array.isArray(raw) ? raw.join('、') : String(raw ?? '');
      }
      fieldStrings[rec.recordId] = strings;
    }
    pageToken = page.pageToken;
  } while (pageToken !== undefined && pageToken !== null);
  return fieldStrings;
}

/**
 * 采集附件。onProgress 用于 UI 更新进度。
 */
export async function collectAttachments(
  table: ITable,
  attachmentFieldIds: string[],
  scope: 'all' | 'view',
  onProgress: (p: ProgressInfo) => void
): Promise<CollectResult> {
  onProgress({ phase: 'collecting', processed: 0, total: 0, message: '正在读取记录…' });

  // 附件字段实例
  const fields: IAttachmentField[] = [];
  const fieldNameById: Record<string, string> = {};
  for (const id of attachmentFieldIds) {
    const f = await table.getField<IAttachmentField>(id);
    fields.push(f);
    const meta = await table.getFieldMetaById(id);
    fieldNameById[id] = meta.name;
  }

  // 记录集合 + 全字段展示值
  const fieldStrings = await readAllFieldStrings(table);
  const allRecordIds = Object.keys(fieldStrings);

  // 视图范围过滤
  let viewIds: Set<string> | null = null;
  if (scope === 'view') {
    const ids = await getViewRecordIds(table);
    viewIds = ids ? new Set(ids) : null;
  }
  const recordIds = viewIds ? allRecordIds.filter((id) => viewIds!.has(id)) : allRecordIds;

  // 读取附件
  const items: AttachmentItem[] = [];
  const countByField: Record<string, number> = {};
  attachmentFieldIds.forEach((id) => (countByField[id] = 0));
  const recordsWithAttachment: Set<string> = new Set();

  for (const recordId of recordIds) {
    for (const field of fields) {
      let attachments: IOpenAttachment[];
      try {
        attachments = await field.getValue(recordId);
      } catch {
        attachments = [];
      }
      if (!attachments || !attachments.length) continue;

      // 换取临时下载链接（顺序与附件数组一致）
      let urls: string[] = [];
      try {
        urls = await field.getAttachmentUrls(recordId);
      } catch {
        try {
          urls = await table.getCellAttachmentUrls(
            attachments.map((a) => a.token),
            field.id,
            recordId
          );
        } catch {
          urls = [];
        }
      }

      attachments.forEach((a, i) => {
        const url = urls[i];
        if (!url) return;
        items.push({
          originalName: a.name,
          token: a.token,
          url,
          size: a.size ?? 0,
          recordId,
          fieldId: field.id,
          fieldName: fieldNameById[field.id] ?? field.id,
        });
        countByField[field.id] = (countByField[field.id] ?? 0) + 1;
      });
      recordsWithAttachment.add(recordId);
    }
  }

  return {
    items,
    fieldNameById,
    countByField,
    recordCount: recordsWithAttachment.size,
    fieldStrings,
  };
}

/** 下载单个附件为 Blob；失败抛错，由上层单独记录，不中断整体流程 */
async function downloadBlob(url: string, timeoutMs = 120000): Promise<Blob> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.blob();
  } finally {
    clearTimeout(timer);
  }
}

/** 触发浏览器下载指定 Blob */
export function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * 执行完整流程：采集 -> 下载 -> 打包 ZIP -> 触发下载。
 *
 * @param template    命名模板（如 {姓名}_{日期}_{序号}）
 * @param scope       记录范围
 * @param onProgress  进度回调
 */
export interface RunResult {
  zipName: string;
  itemCount: number;
  failed: string[];
  totalBytes: number;
  countByField: Record<string, number>;
  recordCount: number;
}
export async function runDownload(
  template: string,
  scope: 'all' | 'view',
  onProgress: (p: ProgressInfo) => void
): Promise<RunResult> {
  const table = await bitable.base.getActiveTable();
  const attachmentMeta = await table.getFieldMetaListByType(FieldType.Attachment);
  if (!attachmentMeta.length) throw new Error('当前数据表没有附件字段');
  const attachmentFieldIds = attachmentMeta.map((m) => m.id);

  const { items, countByField, recordCount, fieldStrings } = await collectAttachments(
    table,
    attachmentFieldIds,
    scope,
    onProgress
  );

  if (!items.length) throw new Error('所选范围内没有找到附件');

  const date = new Date().toISOString().slice(0, 10);
  const used = new Set<string>();
  const zip = new JSZip();

  // 按字段名汇总附件数量，便于展示
  const countByName: Record<string, number> = {};
  const fieldNameById = await (async () => {
    const map: Record<string, string> = {};
    for (const id of attachmentFieldIds) {
      map[id] = (await table.getFieldMetaById(id)).name;
    }
    return map;
  })();
  Object.entries(countByField).forEach(([id, c]) => {
    if (c > 0) countByName[fieldNameById[id] ?? id] = c;
  });

  let processed = 0;
  const failed: string[] = [];

  for (const [idx, item] of items.entries()) {
    onProgress({
      phase: 'downloading',
      processed,
      total: items.length,
      message: `${item.fieldName}/${item.originalName}`,
    });
    try {
      const blob = await downloadBlob(item.url);
      const ctx: NamingContext = {
        fieldValues: fieldStrings[item.recordId] ?? {},
        originalName: item.originalName,
        index: idx + 1,
        date,
      };
      const base = buildBaseName(template, ctx);
      const { name } = makeUniqueName(base, item.originalName.split('.').pop() ?? '', used);
      zip.file(name, blob);
    } catch (e) {
      failed.push(`${item.fieldName}/${item.originalName}：${(e as Error).message}`);
    }
    processed++;
  }

  onProgress({ phase: 'zipping', processed, total: items.length, message: '正在生成 ZIP…' });
  const blob = await zip.generateAsync({ type: 'blob' });

  const tableName = (await table.getName()) || '附件';
  const zipName = `${tableName}_附件_${date}.zip`;
  triggerDownload(blob, zipName);

  onProgress({ phase: 'done', processed: items.length, total: items.length, message: '完成' });

  return {
    zipName,
    itemCount: items.length,
    failed,
    totalBytes: items.reduce((s, it) => s + it.size, 0),
    countByField: countByName,
    recordCount,
  };
}
