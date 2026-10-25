import type { CSSProperties, ReactNode } from 'react';
import { L } from '../labels';
import { printCss } from '../styles';
import type { PrintDocument } from '../types';
import { PrintFooter } from './print-footer';
import { PrintHeader } from './print-header';

/**
 * One printed document: header, title, body, footer and — on reprints — the DUPLICATE watermark.
 * Used as-is by the web print route and, via `renderPrintHtml`, by the worker's PDF job, so the
 * two can never drift apart (docs/01 §4).
 */
export function PrintPage({ doc }: { doc: PrintDocument }) {
  const { template, header, meta, body } = doc;
  const paper = template.paper;
  const isLabel = paper === 'label50x25';
  const duplicate = meta.copyNo > 1;
  const style = header.accent ? ({ '--print-accent': header.accent } as CSSProperties) : undefined;
  return (
    <div
      className={`print-root print-paper-${paper}`}
      style={style}
      data-template={template.key}
      data-copy={meta.copyNo}
    >
      <style dangerouslySetInnerHTML={{ __html: printCss(paper) }} />
      <div className="print-sheet">
        {duplicate && (
          <div className="print-watermark" aria-hidden="true" data-testid="duplicate-watermark">
            <span>
              {L.duplicate.en}
              <small>
                {L.duplicate.hi} #{meta.copyNo}
              </small>
            </span>
          </div>
        )}
        <PrintHeader header={header} paper={paper} />
        {duplicate && !isLabel && (
          <p className="print-duplicate-line">
            {L.duplicateCopy.hi} / {L.duplicateCopy.en} #{meta.copyNo}
          </p>
        )}
        {!isLabel && <Title title={template.title} />}
        <div className="print-body">{body}</div>
        {!isLabel && <PrintFooter header={header} meta={meta} />}
      </div>
    </div>
  );
}

function Title({ title }: { title: PrintDocument['template']['title'] }): ReactNode {
  return (
    <h2 className="print-title">
      <span>{title.hi}</span>
      <span className="print-title-en">{title.en}</span>
    </h2>
  );
}
