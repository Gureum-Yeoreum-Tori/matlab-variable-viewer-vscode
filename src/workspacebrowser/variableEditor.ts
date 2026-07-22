// Copyright 2026 MATLAB Variable Viewer fork contributors.

// A loaded window overlaps the next navigation step. This lets the webview
// keep showing already-rendered cells while the next window is fetched.
export const VARIABLE_PAGE_ROWS = 160
export const VARIABLE_PAGE_COLUMNS = 60
export const VARIABLE_PAGE_ROW_STRIDE = 80
export const VARIABLE_PAGE_COLUMN_STRIDE = 30
export const VARIABLE_COPY_CELL_LIMIT = 10000

export interface VariableMetadata {
    name: string
    class: string
    size: number[]
}

export interface VariableSelection {
    rowStart: number
    rowEnd: number
    columnStart: number
    columnEnd: number
}

export interface VariableEditorWebviewMessage {
    type: 'ready' | 'page' | 'autoRefresh' | 'copySelection' | 'openNested'
    rowStart?: number
    columnStart?: number
    pages?: number[]
    source?: 'manual' | 'scroll' | 'prefetch'
    autoRefresh?: boolean
    enabled?: boolean
    selection?: VariableSelection
    expression?: string
}

const isPositiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0

export function isVariableEditorWebviewMessage (value: unknown): value is VariableEditorWebviewMessage {
    if (value == null || typeof value !== 'object') return false
    const message = value as Record<string, unknown>
    switch (message.type) {
        case 'ready':
            return message.autoRefresh == null || typeof message.autoRefresh === 'boolean'
        case 'page':
            return isPositiveInteger(message.rowStart) &&
                isPositiveInteger(message.columnStart) &&
                Array.isArray(message.pages) &&
                message.pages.length <= 32 &&
                message.pages.every(isPositiveInteger) &&
                (message.source == null || ['manual', 'scroll', 'prefetch'].includes(String(message.source)))
        case 'autoRefresh':
            return typeof message.enabled === 'boolean'
        case 'copySelection': {
            if (!Array.isArray(message.pages) || message.pages.length > 32 || !message.pages.every(isPositiveInteger)) return false
            if (message.selection == null || typeof message.selection !== 'object') return false
            const selection = message.selection as Record<string, unknown>
            return ['rowStart', 'rowEnd', 'columnStart', 'columnEnd'].every(key => isPositiveInteger(selection[key]))
        }
        case 'openNested':
            return typeof message.expression === 'string' && /^[A-Za-z]\w*(?:\.[A-Za-z]\w*)*$/.test(message.expression)
        default:
            return false
    }
}

export function boundValueForWebview (value: unknown, maximumDepth = 8, maximumNodes = 50_000): unknown {
    let nodes = 0
    const visit = (item: unknown, depth: number): unknown => {
        nodes++
        if (nodes > maximumNodes) return '[Truncated: value limit reached]'
        if (item == null || typeof item !== 'object') return item
        if (depth >= maximumDepth) return '[Truncated: maximum depth reached]'
        if (Array.isArray(item)) return item.map(child => visit(child, depth + 1))
        return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child, depth + 1)]))
    }
    return visit(value, 0)
}

export interface SerializedTablePayload {
    columnNames?: unknown
    rowNames?: unknown
    rows?: unknown
}

export interface SliceFingerprintPayload {
    sumReal?: unknown
    sumImag?: unknown
    sumAbs?: unknown
    weightedReal?: unknown
    weightedImag?: unknown
    nanCount?: unknown
}

export function sliceFingerprintSignatures (payload: SliceFingerprintPayload, count: number): string[] {
    const toList = (value: unknown): unknown[] => value == null ? [] : (Array.isArray(value) ? value.flat(2) : [value])
    const metrics = [
        toList(payload.sumReal),
        toList(payload.sumImag),
        toList(payload.sumAbs),
        toList(payload.weightedReal),
        toList(payload.weightedImag),
        toList(payload.nanCount)
    ]
    return Array.from({ length: count }, (_, index) => JSON.stringify(metrics.map(metric => metric[index] ?? null)))
}

export function tablePayloadToGrid (payload: SerializedTablePayload): {
    columnNames: string[]
    rowNames: string[]
    values: unknown[][]
} {
    const toStrings = (value: unknown): string[] => {
        if (value == null) return []
        return (Array.isArray(value) ? value.flat(2) : [value]).map(item => String(item))
    }
    const columnNames = toStrings(payload.columnNames)
    const rowNames = toStrings(payload.rowNames)
    const records = payload.rows == null ? [] : (Array.isArray(payload.rows) ? payload.rows.flat(1) : [payload.rows])
    const values = records.map(record => {
        const row = record != null && typeof record === 'object' ? record as Record<string, unknown> : {}
        return columnNames.map(name => row[name])
    })
    return { columnNames, rowNames, values }
}

// Decode the MATLAB Data Array wire format returned by MVM.feval. Keeping
// numeric and cell values in MDA form avoids an extra MATLAB jsonencode pass
// and preserves the row/column shape of heterogeneous table cells.
export function parseMda (value: any): any { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (value == null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(parseMda)
    if (!('mwtype' in value) || !('mwsize' in value) || !('mwdata' in value)) {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, parseMda(item)]))
    }
    const size = value.mwsize as number[]
    const data = value.mwdata
    if (value.mwtype === 'struct') {
        const count = (size[0] ?? 1) * (size[1] ?? 1)
        const items = Array.from({ length: count }, (_, index) => Object.fromEntries(
            Object.entries(data).map(([key, field]) => {
                return [key, parseMda(Array.isArray(field) ? field[index] : field)]
            })
        ))
        if (count === 1) return items[0]
        const rows = size[0] ?? 1
        const columns = size[1] ?? 1
        if (rows === 1 || columns === 1) return items
        return Array.from({ length: rows }, (_, row) =>
            Array.from({ length: columns }, (_, column) => items[column * rows + row])
        )
    }
    if (value.mwtype === 'char') return Array.isArray(data) ? data[0] : data
    const flat = (Array.isArray(data) ? data : [data]).map(parseMda)
    const rows = size[0] ?? 1
    const columns = size[1] ?? 1
    if (rows === 1 && columns === 1) return flat[0]
    if (rows === 1 || columns === 1) return flat
    return Array.from({ length: rows }, (_, row) =>
        Array.from({ length: columns }, (_, column) => flat[column * rows + row])
    )
}

export function valuesToTsv (value: unknown, rowCount: number, columnCount: number): string {
    let rows: unknown[][]
    if (rowCount === 1) {
        rows = [Array.isArray(value) ? value : [value]]
    } else if (columnCount === 1) {
        rows = (Array.isArray(value) ? value : [value]).map(item => [item])
    } else {
        rows = (Array.isArray(value) ? value : [value]).map(item => Array.isArray(item) ? item : [item])
    }

    const encodeCell = (item: unknown): string => {
        let text: string
        if (item == null) text = ''
        else if (typeof item === 'object') text = JSON.stringify(item)
        else text = String(item)
        return /[\t\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
    }
    return rows.map(row => row.map(encodeCell).join('\t')).join('\n')
}

export function getVariableEditorHtml (name: string, nonce = 'variable-editor-test-nonce'): string {
    const safeName = JSON.stringify(name)
    return `<!doctype html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src-elem 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
:root{--row-height:28px;--header-height:28px;--row-header-width:58px;--column-width:112px}
*{box-sizing:border-box}html,body{height:100%;margin:0;overflow:hidden}body{display:flex;flex-direction:column;font-family:var(--vscode-font-family);font-size:12px;color:var(--vscode-foreground);background:var(--vscode-editor-background)}
button,select,input{height:26px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);border-radius:3px;font:inherit}button{padding:2px 8px;cursor:pointer}button:hover:not(:disabled){background:var(--vscode-button-secondaryHoverBackground)}button:disabled{opacity:.38;cursor:default}button:focus-visible,select:focus-visible,input:focus-visible,#matrixViewport:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
#toolbar{display:flex;align-items:center;gap:8px;min-height:42px;padding:7px 10px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-editorGroupHeader-tabsBackground);white-space:nowrap;overflow-x:auto}
#identity{display:flex;align-items:baseline;gap:8px;margin-right:4px}.title{font-weight:650;font-size:13px}.muted{color:var(--vscode-descriptionForeground)}.toolbar-group{display:flex;align-items:center;gap:4px;padding-left:8px;border-left:1px solid var(--vscode-panel-border)}.toolbar-group[hidden]{display:none}.range{min-width:118px;text-align:center;font-variant-numeric:tabular-nums}.icon-button{min-width:28px;padding:2px 6px}.precision{width:48px}.format-select{min-width:76px}
#dimensionBar{display:flex;align-items:center;gap:10px;min-height:38px;padding:5px 10px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);overflow-x:auto;white-space:nowrap}#dimensionBar[hidden]{display:none}#dimensionBar.changed{animation:dimension-changed 1100ms ease-out}.dimension-caption{position:sticky;left:0;z-index:2;padding-right:6px;background:var(--vscode-sideBar-background);font-weight:650}.dimensions{display:flex;align-items:center;gap:8px}.dimension-control{display:flex;align-items:center;gap:4px;padding:2px 5px;border:1px solid var(--vscode-panel-border);border-radius:4px;background:var(--vscode-editor-background)}.dimension-name{font-weight:600}.dimension-input{width:58px;text-align:center;font-variant-numeric:tabular-nums}.dimension-total{min-width:34px;color:var(--vscode-descriptionForeground)}.slice-overview{display:flex;align-items:center;gap:5px;padding-left:10px;border-left:1px solid var(--vscode-panel-border)}.slice-overview[hidden]{display:none}.slice-caption{color:var(--vscode-descriptionForeground)}.slice-list{display:flex;align-items:center;gap:3px}.slice-chip{position:relative;min-width:28px;height:24px;padding:1px 6px;font-family:var(--vscode-editor-font-family);font-variant-numeric:tabular-nums}.slice-chip.active{border-color:var(--vscode-focusBorder);background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}.slice-chip.changed::after{content:'';position:absolute;right:2px;top:2px;width:6px;height:6px;border-radius:50%;background:var(--vscode-editorWarning-foreground);box-shadow:0 0 5px var(--vscode-editorWarning-foreground)}.slice-gap{color:var(--vscode-descriptionForeground);padding:0 2px}
#autoButton{display:flex;align-items:center;gap:6px}.auto-dot{width:7px;height:7px;border-radius:50%;background:var(--vscode-testing-iconPassed);box-shadow:0 0 5px color-mix(in srgb,var(--vscode-testing-iconPassed) 65%,transparent)}#autoButton.paused .auto-dot{background:var(--vscode-descriptionForeground);box-shadow:none}
#main{position:relative;flex:1;min-height:0}.loading-overlay{position:absolute;right:12px;top:10px;z-index:30;padding:5px 9px;border:1px solid var(--vscode-panel-border);border-radius:4px;background:var(--vscode-editorWidget-background);color:var(--vscode-descriptionForeground);box-shadow:0 2px 8px var(--vscode-widget-shadow)}
#matrixViewport{position:absolute;inset:0;overflow:auto;background:var(--vscode-editor-background)}#matrixViewport[hidden],#inspector[hidden],#drawer[hidden],.loading-overlay[hidden]{display:none}
#matrixSpacer,#cellLayer,#columnHeaderLayer,#rowHeaderLayer{position:absolute;left:0;top:0}.header-cell,.row-header,.data-cell,#corner{position:absolute;border-right:1px solid var(--vscode-panel-border);border-bottom:1px solid var(--vscode-panel-border);overflow:hidden}.header-cell,.row-header,#corner{display:flex;align-items:center;justify-content:center;background:var(--vscode-editorGroupHeader-tabsBackground);color:var(--vscode-descriptionForeground);font-variant-numeric:tabular-nums;user-select:none}.header-cell{top:0;height:var(--header-height);width:var(--column-width);pointer-events:auto}.row-header{left:0;width:var(--row-header-width);height:var(--row-height);pointer-events:auto}.header-cell:hover,.row-header:hover,#corner:hover{background:var(--vscode-list-hoverBackground);color:var(--vscode-foreground)}
.data-cell{display:flex;align-items:center;justify-content:flex-end;width:var(--column-width);height:var(--row-height);padding:3px 7px;text-align:right;font-family:var(--vscode-editor-font-family);font-variant-numeric:tabular-nums;white-space:nowrap;text-overflow:ellipsis;background:var(--vscode-editor-background);cursor:default}.data-cell:hover{background:var(--vscode-list-hoverBackground)}.data-cell.selected{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}.data-cell.active{outline:1px solid var(--vscode-focusBorder);outline-offset:-2px}.data-cell.changed,.primitive.changed{animation:changed-cell 900ms ease-out}.cell-summary{max-width:100%;overflow:hidden;text-overflow:ellipsis;color:var(--vscode-textLink-foreground)}
@keyframes changed-cell{0%{background:var(--vscode-editorWarning-background);box-shadow:inset 0 0 0 1px var(--vscode-editorWarning-foreground)}100%{background:inherit;box-shadow:none}}
@keyframes dimension-changed{0%{background:var(--vscode-editorWarning-background);box-shadow:inset 0 0 0 1px var(--vscode-editorWarning-foreground)}100%{background:var(--vscode-sideBar-background);box-shadow:none}}
#columnHeaderLayer{height:var(--header-height);z-index:12;pointer-events:none;will-change:transform}#rowHeaderLayer{width:var(--row-header-width);z-index:11;pointer-events:none;will-change:transform}#cellLayer{z-index:2}#corner{left:0;top:0;width:var(--row-header-width);height:var(--header-height);z-index:20;padding:0;will-change:transform}
#inspector{position:absolute;inset:0;overflow:auto;padding:12px 14px}.struct-card{max-width:1100px;border:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background)}.field-row{border-bottom:1px solid var(--vscode-panel-border)}.field-row:last-child{border-bottom:0}.field-summary,.scalar-field{display:grid;grid-template-columns:minmax(130px,1fr) minmax(120px,auto) minmax(120px,2fr);align-items:center;gap:12px;min-height:34px;padding:5px 10px}.field-summary{cursor:pointer;list-style:none}.field-summary::-webkit-details-marker{display:none}.field-summary::before{content:'›';position:absolute;margin-left:-1px;transform:rotate(0);transition:transform .1s}.field-row[open]>.field-summary::before{transform:rotate(90deg)}.field-row.branch-changed>.field-summary{animation:changed-branch 1500ms ease-out}.field-name{padding-left:14px;font-family:var(--vscode-editor-font-family);font-weight:600}.type-badge{color:var(--vscode-descriptionForeground);font-family:var(--vscode-editor-font-family)}.field-preview{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;font-family:var(--vscode-editor-font-family)}.field-content{padding:8px 12px 12px 26px;background:var(--vscode-editor-background)}.field-actions{display:inline-flex;align-items:center;justify-content:flex-end;gap:5px}.change-badge{padding:2px 6px;border:1px solid var(--vscode-editorWarning-foreground);border-radius:10px;color:var(--vscode-editorWarning-foreground);font-size:10px;font-weight:650}.open-field{height:22px;padding:1px 7px}.nested-table{border-collapse:collapse;font-family:var(--vscode-editor-font-family);font-variant-numeric:tabular-nums}.nested-table th,.nested-table td{min-width:72px;height:26px;padding:3px 7px;border:1px solid var(--vscode-panel-border);text-align:right}.nested-table th{background:var(--vscode-editorGroupHeader-tabsBackground);color:var(--vscode-descriptionForeground)}.empty{padding:18px;color:var(--vscode-descriptionForeground)}
@keyframes changed-branch{0%{background:var(--vscode-editorWarning-background);box-shadow:inset 3px 0 var(--vscode-editorWarning-foreground)}100%{background:inherit;box-shadow:none}}
#drawer{position:absolute;right:0;top:0;bottom:0;width:min(560px,55vw);z-index:25;border-left:1px solid var(--vscode-panel-border);background:var(--vscode-editor-background);box-shadow:-5px 0 15px var(--vscode-widget-shadow)}#drawerHeader{display:flex;align-items:center;justify-content:space-between;height:38px;padding:6px 10px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-editorGroupHeader-tabsBackground)}#drawerContent{height:calc(100% - 38px);overflow:auto;padding:10px}
#statusbar{display:flex;align-items:center;gap:12px;min-height:24px;padding:3px 9px;border-top:1px solid var(--vscode-panel-border);background:var(--vscode-statusBar-background);color:var(--vscode-statusBar-foreground);font-size:11px}#selectionStatus{font-family:var(--vscode-editor-font-family);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#toast{margin-left:auto;opacity:0;transition:opacity .15s}#toast.visible{opacity:1}.error{padding:16px;color:var(--vscode-errorForeground)}
body.compact #updatedAt{display:none}@media(max-width:850px){#updatedAt{display:none}.field-summary,.scalar-field{grid-template-columns:minmax(100px,1fr) minmax(90px,auto) minmax(80px,1fr)}}
</style>
</head>
<body>
<div id="toolbar">
  <div id="identity"><span id="title" class="title">${name}</span><span id="meta" class="muted">Loading…</span></div>
  <div id="rowNavigation" class="toolbar-group" hidden><button id="prevRows" class="icon-button" title="Previous rows">‹</button><span id="rowRange" class="range"></span><button id="nextRows" class="icon-button" title="Next rows">›</button></div>
  <div id="columnNavigation" class="toolbar-group" hidden><button id="prevCols" class="icon-button" title="Previous columns">‹</button><span id="columnRange" class="range"></span><button id="nextCols" class="icon-button" title="Next columns">›</button></div>
  <div class="toolbar-group"><select id="numberFormat" class="format-select" title="Number format"><option value="short">short</option><option value="long">long</option><option value="shortE">shortE</option><option value="longE">longE</option><option value="custom">custom</option></select><input id="precision" class="precision" type="number" min="0" max="15" title="Decimal places" hidden><button id="fitColumns" title="Fit columns to visible values">Fit</button></div>
  <div class="toolbar-group"><button id="copyButton" disabled title="Copy selected cells (Cmd/Ctrl+C)">Copy</button><button id="autoButton" title="Pause automatic updates"><span class="auto-dot"></span><span id="autoLabel">Auto</span></button><span id="updatedAt" class="muted"></span></div>
</div>
<div id="dimensionBar" hidden><span class="dimension-caption">Higher dimensions</span><div id="dimensions" class="dimensions"></div><div id="sliceOverview" class="slice-overview" hidden><span class="slice-caption">Slices</span><div id="sliceList" class="slice-list"></div></div></div>
<div id="main">
  <div id="loading" class="loading-overlay">Loading…</div>
  <div id="matrixViewport" tabindex="0" role="grid" aria-label="MATLAB variable values" hidden>
    <div id="matrixSpacer"></div><div id="cellLayer"></div><div id="columnHeaderLayer"></div><div id="rowHeaderLayer"></div><button id="corner" title="Select all">⌗</button>
  </div>
  <div id="inspector" hidden></div>
  <aside id="drawer" hidden><div id="drawerHeader"><strong id="drawerTitle"></strong><button id="closeDrawer">Close</button></div><div id="drawerContent"></div></aside>
</div>
<div id="statusbar"><span id="selectionStatus">No selection</span><span id="toast"></span></div>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();
const variable=${safeName};
const PAGE_ROWS=${VARIABLE_PAGE_ROWS},PAGE_COLUMNS=${VARIABLE_PAGE_COLUMNS},ROW_STRIDE=${VARIABLE_PAGE_ROW_STRIDE},COLUMN_STRIDE=${VARIABLE_PAGE_COLUMN_STRIDE},ROW_PREFETCH_MARGIN=20,COLUMN_PREFETCH_MARGIN=5,ROW_HEIGHT=28,HEADER_HEIGHT=28;let ROW_HEADER_WIDTH=58;
const saved=vscode.getState()||{};
const state={metadata:null,values:null,rowStart:1,columnStart:1,rowEnd:1,columnEnd:1,pages:[],columnNames:[],rowNames:[],sliceSignatures:[],changedSlices:new Set(),pendingKey:'',source:'initial',autoRefresh:saved.autoRefresh!==false,numberFormat:['short','long','shortE','longE','custom'].includes(saved.numberFormat)?saved.numberFormat:'short',precision:Number.isInteger(saved.precision)?Math.max(0,Math.min(15,saved.precision)):4,columnWidth:Number.isFinite(saved.columnWidth)?Math.max(72,Math.min(320,saved.columnWidth)):112,selection:null,anchor:null,active:null,dragging:false,signatureWindows:new Map(),inspectorSignatures:new Map(),drawerSignatures:new Map(),inspectorOpenPaths:new Set(),drawerOpenPaths:new Set(),drawerCell:null,changedCells:new Set(),changedClearTimer:0,dimensionFlashTimer:0,renderFrame:0};
const el=id=>document.getElementById(id);
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const escapeHtml=value=>String(value).replace(/[&<>"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[char]));
const stable=value=>{try{return JSON.stringify(value);}catch{return String(value);}};
const stringList=value=>value==null?[]:(Array.isArray(value)?value.flat(2):[value]).map(item=>String(item));
function persist(){vscode.setState({autoRefresh:state.autoRefresh,numberFormat:state.numberFormat,precision:state.precision,columnWidth:state.columnWidth});}
function formatNumber(value){if(!Number.isFinite(value))return String(value);const abs=Math.abs(value);if(state.numberFormat==='shortE')return value.toExponential(4);if(state.numberFormat==='longE')return value.toExponential(15);if(state.numberFormat==='long')return value===0?'0':((abs<1e-4||abs>=1e15)?value.toExponential(15):value.toPrecision(15));if(state.numberFormat==='custom')return value.toFixed(state.precision);return value===0?'0':((abs<1e-3||abs>=1e4)?value.toExponential(4):value.toFixed(4));}
function scalarText(value){if(value===null||value===undefined)return '';if(typeof value==='number')return formatNumber(value);if(typeof value==='boolean')return value?'true':'false';return String(value);}
function isScalar(value){return value===null||typeof value!=='object';}
function rectangularMatrix(value){if(!Array.isArray(value)||value.length===0||!value.every(Array.isArray))return null;const columns=value[0].length;if(columns===0||!value.every(row=>row.length===columns&&row.every(isScalar)))return null;return value;}
function scalarType(value){if(value===null||value===undefined)return 'empty';if(typeof value==='number')return 'number';if(typeof value==='boolean')return 'logical';if(typeof value==='string')return 'string';return typeof value;}
function describe(value){if(isScalar(value))return scalarType(value);const matrix=rectangularMatrix(value);if(matrix)return matrix.length+'×'+matrix[0].length+' '+scalarType(matrix[0][0]);if(Array.isArray(value)){if(value.every(isScalar))return '1×'+value.length+' '+(value.length?scalarType(value[0]):'empty');return value.length+' elements';}return Object.keys(value).length+' fields';}
function matrixOf(value,rows,columns){if(rows===1)return [Array.isArray(value)?value:[value]];if(columns===1)return (Array.isArray(value)?value:[value]).map(item=>[item]);return (Array.isArray(value)?value:[value]).map(item=>Array.isArray(item)?item:[item]);}
function valuePreview(value){if(isScalar(value))return escapeHtml(scalarText(value));return '<span class="cell-summary">'+escapeHtml(describe(value))+'</span>';}
function signaturesFor(path){return path.startsWith('$drawer')?state.drawerSignatures:state.inspectorSignatures;}
function openPathsFor(path){return path.startsWith('$drawer')?state.drawerOpenPaths:state.inspectorOpenPaths;}
function captureOpenPaths(container){return new Set(Array.from(container.querySelectorAll('details[open][data-path]')).map(details=>details.dataset.path));}
function leafChanged(value,path){const signatures=signaturesFor(path),previous=signatures.get(path);return state.source==='auto'&&signatures.size>0&&(previous===undefined||previous!==stable(value));}
function countChangedLeaves(value,path,depth=0){if(state.source!=='auto'||depth>7)return 0;if(isScalar(value))return leafChanged(value,path)?1:0;if(Array.isArray(value))return value.reduce((total,item,index)=>total+countChangedLeaves(item,path+'['+index+']',depth+1),0);return Object.entries(value).reduce((total,[key,item])=>total+countChangedLeaves(item,path+'.'+key,depth+1),0);}
function nestedMatrixHtml(matrix,path,isVector=false){const columns=matrix[0].length;return '<table class="nested-table"><thead><tr><th></th>'+matrix[0].map((_,index)=>'<th>'+(index+1)+'</th>').join('')+'</tr></thead><tbody>'+matrix.map((row,rowIndex)=>'<tr><th>'+(rowIndex+1)+'</th>'+row.map((value,columnIndex)=>primitiveHtml(value,isVector?path+'['+columnIndex+']':path+'['+rowIndex+']['+columnIndex+']')).join('')+'</tr>').join('')+'</tbody></table>';}
function primitiveHtml(value,path){return '<td class="primitive'+(leafChanged(value,path)?' changed':'')+'">'+escapeHtml(scalarText(value))+'</td>';}
function valueContentHtml(value,path,expression,depth){if(depth>6)return '<span class="muted">Maximum depth reached</span>';const matrix=rectangularMatrix(value);if(matrix)return nestedMatrixHtml(matrix,path);if(Array.isArray(value)&&value.every(isScalar))return nestedMatrixHtml([value],path,true);if(Array.isArray(value))return '<div class="struct-card">'+value.map((item,index)=>fieldHtml(String(index+1),item,path+'['+index+']','',depth+1)).join('')+'</div>';if(value&&typeof value==='object')return objectHtml(value,path,expression,depth+1);return '<span>'+escapeHtml(scalarText(value))+'</span>';}
function fieldHtml(key,value,path,expression,depth){const compound=!isScalar(value),fieldExpression=expression?expression+'.'+key:'';if(!compound){const changed=leafChanged(value,path);return '<div class="field-row scalar-field"><span class="field-name">'+escapeHtml(key)+'</span><span class="type-badge">'+escapeHtml(describe(value))+'</span><span class="field-preview primitive'+(changed?' changed':'')+'">'+escapeHtml(scalarText(value))+'</span></div>';}const canOpen=/^[A-Za-z]\\w*(?:\\.[A-Za-z]\\w*)*$/.test(fieldExpression),changedCount=countChangedLeaves(value,path),isOpen=openPathsFor(path).has(path);return '<details class="field-row'+(changedCount?' branch-changed':'')+'" data-path="'+escapeHtml(path)+'"'+(isOpen?' open':'')+'><summary class="field-summary"><span class="field-name">'+escapeHtml(key)+'</span><span class="type-badge">'+escapeHtml(describe(value))+'</span><span class="field-actions">'+(changedCount?'<span class="change-badge">'+changedCount+' changed</span>':'')+(canOpen?'<button class="open-field" data-expression="'+escapeHtml(fieldExpression)+'">Open tab</button>':'')+'</span></summary><div class="field-content">'+valueContentHtml(value,path,fieldExpression,depth+1)+'</div></details>';}
function objectHtml(value,path,expression,depth){const entries=Object.entries(value);if(entries.length===0)return '<div class="empty">Empty structure</div>';return '<div class="struct-card">'+entries.map(([key,item])=>fieldHtml(key,item,path+'.'+key,expression,depth)).join('')+'</div>';}
function collectSignatures(value,path,target,depth=0){if(depth>7)return;if(isScalar(value)){target.set(path,stable(value));return;}if(Array.isArray(value)){value.forEach((item,index)=>collectSignatures(item,path+'['+index+']',target,depth+1));return;}Object.entries(value).forEach(([key,item])=>collectSignatures(item,path+'.'+key,target,depth+1));}
function renderInspector(){el('matrixViewport').hidden=true;el('inspector').hidden=false;state.inspectorOpenPaths=captureOpenPaths(el('inspector'));el('inspector').innerHTML=state.values&&typeof state.values==='object'&&!Array.isArray(state.values)?objectHtml(state.values,'$',variable,0):valueContentHtml(state.values,'$',variable,0);const next=new Map();collectSignatures(state.values,'$',next);state.inspectorSignatures=next;bindOpenFieldButtons();}
function renderDrawer(value,row,column){const suffix=state.pages.map(index=>','+index).join('');state.drawerOpenPaths=captureOpenPaths(el('drawerContent'));el('drawerTitle').textContent=variable+'('+row+','+column+suffix+') · '+describe(value);el('drawerContent').innerHTML=valueContentHtml(value,'$drawer','',0);const next=new Map();collectSignatures(value,'$drawer',next);state.drawerSignatures=next;el('drawer').hidden=false;}
function bindOpenFieldButtons(){document.querySelectorAll('.open-field').forEach(button=>button.onclick=event=>{event.preventDefault();event.stopPropagation();vscode.postMessage({type:'openNested',expression:button.dataset.expression});});}
function updateCssMetrics(){document.documentElement.style.setProperty('--column-width',state.columnWidth+'px');document.documentElement.style.setProperty('--row-header-width',ROW_HEADER_WIDTH+'px');}
function usesInspector(){return Boolean(state.metadata&&state.metadata.class==='struct'&&state.metadata.size.reduce((total,size)=>total*size,1)===1);}
function visibleBounds(){const viewport=el('matrixViewport'),totalRows=state.metadata.size[0]||1,totalColumns=state.metadata.size[1]||1,visibleRow=clamp(Math.floor(Math.max(0,viewport.scrollTop-HEADER_HEIGHT)/ROW_HEIGHT)+1,1,totalRows),visibleColumn=clamp(Math.floor(Math.max(0,viewport.scrollLeft-ROW_HEADER_WIDTH)/state.columnWidth)+1,1,totalColumns),visibleRows=Math.max(24,Math.ceil(viewport.clientHeight/ROW_HEIGHT)),visibleColumns=Math.max(12,Math.ceil(viewport.clientWidth/state.columnWidth));return{rowStart:clamp(visibleRow-6,state.rowStart,state.rowEnd),rowEnd:clamp(visibleRow+visibleRows+6,state.rowStart,state.rowEnd),columnStart:clamp(visibleColumn-3,state.columnStart,state.columnEnd),columnEnd:clamp(visibleColumn+visibleColumns+3,state.columnStart,state.columnEnd)};}
function renderVisibleMatrix(){if(!state.metadata||usesInspector())return;const rows=state.rowEnd-state.rowStart+1,columns=state.columnEnd-state.columnStart+1,matrix=matrixOf(state.values,rows,columns),bounds=visibleBounds(),cells=[];for(let globalRow=bounds.rowStart;globalRow<=bounds.rowEnd;globalRow++){const row=matrix[globalRow-state.rowStart]||[];for(let globalColumn=bounds.columnStart;globalColumn<=bounds.columnEnd;globalColumn++){const value=row[globalColumn-state.columnStart],key=globalRow+':'+globalColumn,changed=state.changedCells.has(key);cells.push('<div class="data-cell'+(changed?' changed':'')+'" role="gridcell" data-row="'+globalRow+'" data-column="'+globalColumn+'" style="left:'+(ROW_HEADER_WIDTH+(globalColumn-1)*state.columnWidth)+'px;top:'+(HEADER_HEIGHT+(globalRow-1)*ROW_HEIGHT)+'px" title="'+escapeHtml(scalarText(value)||describe(value))+'">'+valuePreview(value)+'</div>');}}el('cellLayer').innerHTML=cells.join('');renderHeaders(bounds);applySelection();syncStickyLayers();}
function renderMatrix(){const metadata=state.metadata,rows=state.rowEnd-state.rowStart+1,columns=state.columnEnd-state.columnStart+1,matrix=matrixOf(state.values,rows,columns),windowKey=state.pages.join(',')+'|'+state.rowStart+':'+state.columnStart,previousSignatures=state.signatureWindows.get(windowKey)||new Map(),nextSignatures=new Map(),changedCells=new Set();el('inspector').hidden=true;el('matrixViewport').hidden=false;const totalRows=metadata.size[0]||1,totalColumns=metadata.size[1]||1,totalWidth=ROW_HEADER_WIDTH+totalColumns*state.columnWidth,totalHeight=HEADER_HEIGHT+totalRows*ROW_HEIGHT;el('matrixSpacer').style.width=totalWidth+'px';el('matrixSpacer').style.height=totalHeight+'px';el('columnHeaderLayer').style.width=totalWidth+'px';el('rowHeaderLayer').style.height=totalHeight+'px';for(let rowIndex=0;rowIndex<matrix.length;rowIndex++){const row=matrix[rowIndex]||[];for(let columnIndex=0;columnIndex<row.length;columnIndex++){const globalRow=state.rowStart+rowIndex,globalColumn=state.columnStart+columnIndex,key=globalRow+':'+globalColumn,signature=stable(row[columnIndex]),previous=previousSignatures.get(key),changed=state.source!=='initial'&&state.source!=='prefetch'&&previous!==undefined&&previous!==signature;if(changed)changedCells.add(key);nextSignatures.set(key,signature);}}state.signatureWindows.delete(windowKey);state.signatureWindows.set(windowKey,nextSignatures);while(state.signatureWindows.size>8)state.signatureWindows.delete(state.signatureWindows.keys().next().value);state.changedCells=changedCells;clearTimeout(state.changedClearTimer);if(changedCells.size>0)state.changedClearTimer=setTimeout(()=>state.changedCells.clear(),950);if(state.drawerCell&&state.drawerCell.pages.join(',')===state.pages.join(',')){const drawerRow=state.drawerCell.row-state.rowStart,drawerColumn=state.drawerCell.column-state.columnStart,value=matrix[drawerRow]?.[drawerColumn];if(value&&typeof value==='object')renderDrawer(value,state.drawerCell.row,state.drawerCell.column);}if(changedCells.size>0&&state.pages.length>0){clearTimeout(state.dimensionFlashTimer);el('dimensionBar').classList.remove('changed');void el('dimensionBar').offsetWidth;el('dimensionBar').classList.add('changed');state.dimensionFlashTimer=setTimeout(()=>el('dimensionBar').classList.remove('changed'),1100);}renderVisibleMatrix();}
function renderHeaders(bounds){const metadata=state.metadata,totalRows=metadata.size[0]||1,totalColumns=metadata.size[1]||1,columnHeaders=[],rowHeaders=[];for(let column=bounds.columnStart;column<=bounds.columnEnd;column++){const label=state.columnNames[column-state.columnStart]??column;columnHeaders.push('<div class="header-cell" data-column="'+column+'" style="left:'+(ROW_HEADER_WIDTH+(column-1)*state.columnWidth)+'px" title="'+escapeHtml(label)+'">'+escapeHtml(label)+'</div>');}for(let row=bounds.rowStart;row<=bounds.rowEnd;row++){const label=state.rowNames[row-state.rowStart]??row;rowHeaders.push('<div class="row-header" data-row="'+row+'" style="top:'+(HEADER_HEIGHT+(row-1)*ROW_HEIGHT)+'px" title="'+escapeHtml(label)+'">'+escapeHtml(label)+'</div>');}el('columnHeaderLayer').innerHTML=columnHeaders.join('');el('rowHeaderLayer').innerHTML=rowHeaders.join('');el('rowRange').textContent='Rows '+bounds.rowStart+'–'+bounds.rowEnd+' / '+totalRows+' · buffer '+state.rowStart+'–'+state.rowEnd;el('columnRange').textContent='Cols '+bounds.columnStart+'–'+bounds.columnEnd+' / '+totalColumns+' · buffer '+state.columnStart+'–'+state.columnEnd;el('prevRows').disabled=state.rowStart<=1;el('nextRows').disabled=state.rowEnd>=totalRows;el('prevCols').disabled=state.columnStart<=1;el('nextCols').disabled=state.columnEnd>=totalColumns;el('rowNavigation').hidden=totalRows<=PAGE_ROWS;el('columnNavigation').hidden=totalColumns<=PAGE_COLUMNS;}
function pageLinearIndex(pages,sizes){let linear=0,multiplier=1;sizes.forEach((size,index)=>{linear+=((pages[index]||1)-1)*multiplier;multiplier*=size;});return linear;}
function pagesForLinear(linear,sizes){return sizes.map(size=>{const page=linear%size+1;linear=Math.floor(linear/size);return page;});}
function resetDrawer(){state.drawerCell=null;state.drawerSignatures=new Map();state.drawerOpenPaths=new Set();el('drawerContent').innerHTML='';el('drawer').hidden=true;}
function setDimension(index,value){const size=state.metadata.size[index+2]||1,next=clamp(Math.floor(Number(value)||1),1,size);if(next===state.pages[index])return;state.pages[index]=next;resetDrawer();renderDimensions();requestPage(state.rowStart,state.columnStart,'manual');}
function setSlice(linear){const sizes=state.metadata.size.slice(2),next=pagesForLinear(linear,sizes);if(next.every((page,index)=>page===state.pages[index]))return;state.pages=next;resetDrawer();renderDimensions();requestPage(state.rowStart,state.columnStart,'manual');}
function renderSliceOverview(sizes){const overview=el('sliceOverview'),total=sizes.reduce((product,size)=>product*size,1);overview.hidden=sizes.length===0;if(sizes.length===0){el('sliceList').innerHTML='';return;}const active=pageLinearIndex(state.pages,sizes),included=new Set();if(total<=64){for(let index=0;index<total;index++)included.add(index);}else{included.add(0);included.add(total-1);for(let index=Math.max(0,active-5);index<=Math.min(total-1,active+5);index++)included.add(index);state.changedSlices.forEach(index=>{if(index<total)included.add(index);});}const indices=Array.from(included).sort((a,b)=>a-b),parts=[];let previous=-2;indices.forEach(index=>{if(index>previous+1)parts.push('<span class="slice-gap">…</span>');const pages=pagesForLinear(index,sizes),label=sizes.length===1?String(pages[0]):'['+pages.join(',')+']',title=pages.map((page,dimension)=>'Dim '+(dimension+3)+' = '+page).join(', '),changed=state.changedSlices.has(index);parts.push('<button class="slice-chip'+(index===active?' active':'')+(changed?' changed':'')+'" data-slice="'+index+'" title="'+title+(changed?' · changed':'')+'">'+label+'</button>');previous=index;});el('sliceList').innerHTML=parts.join('');document.querySelectorAll('.slice-chip').forEach(button=>button.onclick=()=>setSlice(Number(button.dataset.slice)));}
function renderDimensions(){const sizes=state.metadata.size.slice(2),bar=el('dimensionBar');bar.hidden=sizes.length===0;if(sizes.length===0){el('dimensions').innerHTML='';renderSliceOverview(sizes);return;}el('dimensions').innerHTML=sizes.map((size,index)=>{const current=state.pages[index]||1;return '<div class="dimension-control"><span class="dimension-name">Dim '+(index+3)+'</span><button class="icon-button dimension-step" data-dimension="'+index+'" data-step="-1" title="Previous Dim '+(index+3)+' page"'+(current<=1?' disabled':'')+'>‹</button><input class="dimension-input" data-dimension="'+index+'" type="number" min="1" max="'+size+'" value="'+current+'" aria-label="Dim '+(index+3)+' page"><button class="icon-button dimension-step" data-dimension="'+index+'" data-step="1" title="Next Dim '+(index+3)+' page"'+(current>=size?' disabled':'')+'>›</button><span class="dimension-total">/ '+size+'</span></div>';}).join('');document.querySelectorAll('.dimension-input').forEach(input=>input.onchange=()=>setDimension(Number(input.dataset.dimension),input.value));document.querySelectorAll('.dimension-step').forEach(button=>button.onclick=()=>{const index=Number(button.dataset.dimension);setDimension(index,(state.pages[index]||1)+Number(button.dataset.step));});renderSliceOverview(sizes);}
function updateToolbar(){const metadata=state.metadata;el('title').textContent=metadata.name;el('meta').textContent=metadata.size.join(' × ')+' '+metadata.class;el('numberFormat').value=state.numberFormat;el('precision').hidden=state.numberFormat!=='custom';el('autoButton').classList.toggle('paused',!state.autoRefresh);el('autoLabel').textContent=state.autoRefresh?'Auto':'Paused';el('autoButton').title=state.autoRefresh?'Pause automatic updates':'Resume automatic updates';renderDimensions();}
function render(message){const source=message.source||'manual',nextSliceSignatures=stringList(message.sliceSignatures);state.metadata=message.metadata;if(nextSliceSignatures.length){if(state.sliceSignatures.length===nextSliceSignatures.length&&source==='auto')nextSliceSignatures.forEach((signature,index)=>{if(state.sliceSignatures[index]!==signature)state.changedSlices.add(index);});else if(state.sliceSignatures.length!==nextSliceSignatures.length)state.changedSlices.clear();state.sliceSignatures=nextSliceSignatures;}else if(message.sliceSignatures){state.sliceSignatures=[];state.changedSlices.clear();}state.values=message.values;state.rowStart=message.rowStart;state.columnStart=message.columnStart;state.rowEnd=message.rowEnd;state.columnEnd=message.columnEnd;state.pages=message.pageIndices;state.columnNames=stringList(message.columnNames);state.rowNames=stringList(message.rowNames);state.source=source;if(source==='manual')state.changedSlices.delete(pageLinearIndex(state.pages,state.metadata.size.slice(2)));state.pendingKey='';ROW_HEADER_WIDTH=state.rowNames.length?clamp(state.rowNames.reduce((max,label)=>Math.max(max,label.length),1)*8+24,72,220):58;updateCssMetrics();el('loading').hidden=true;if(usesInspector())renderInspector();else renderMatrix();updateToolbar();if(message.updatedAt)el('updatedAt').textContent='Updated '+new Date(message.updatedAt).toLocaleTimeString();}
function requestPage(rowStart,columnStart,source){if(!state.metadata&&source!=='initial')return;const pages=state.pages||[],safeSource=source||'manual',key=rowStart+':'+columnStart+':'+pages.join(',');if(state.pendingKey===key)return;state.pendingKey=key;if(safeSource!=='prefetch'&&safeSource!=='scroll')el('loading').hidden=false;vscode.postMessage({type:'page',rowStart,columnStart,pages,source:safeSource});}
function goTo(rowStart,columnStart){const metadata=state.metadata;if(!metadata)return;const row=clamp(rowStart,1,metadata.size[0]||1),column=clamp(columnStart,1,metadata.size[1]||1),windowRow=Math.floor((row-1)/ROW_STRIDE)*ROW_STRIDE+1,windowColumn=Math.floor((column-1)/COLUMN_STRIDE)*COLUMN_STRIDE+1;el('matrixViewport').scrollTo({top:Math.max(0,HEADER_HEIGHT+(row-1)*ROW_HEIGHT-HEADER_HEIGHT),left:Math.max(0,ROW_HEADER_WIDTH+(column-1)*state.columnWidth-ROW_HEADER_WIDTH),behavior:'smooth'});if(windowRow!==state.rowStart||windowColumn!==state.columnStart)requestPage(windowRow,windowColumn,'prefetch');}
function syncStickyLayers(){const viewport=el('matrixViewport'),x=viewport.scrollLeft,y=viewport.scrollTop;el('columnHeaderLayer').style.transform='translateY('+y+'px)';el('rowHeaderLayer').style.transform='translateX('+x+'px)';el('corner').style.transform='translate('+x+'px,'+y+'px)';}
let scrollTimer=0;el('matrixViewport').addEventListener('scroll',()=>{syncStickyLayers();cancelAnimationFrame(state.renderFrame);state.renderFrame=requestAnimationFrame(renderVisibleMatrix);clearTimeout(scrollTimer);scrollTimer=setTimeout(()=>{if(!state.metadata||state.pendingKey)return;const viewport=el('matrixViewport'),totalRows=state.metadata.size[0]||1,totalColumns=state.metadata.size[1]||1,visibleRow=clamp(Math.floor(Math.max(0,viewport.scrollTop-HEADER_HEIGHT)/ROW_HEIGHT)+1,1,totalRows),visibleColumn=clamp(Math.floor(Math.max(0,viewport.scrollLeft-ROW_HEADER_WIDTH)/state.columnWidth)+1,1,totalColumns),visibleBottom=clamp(visibleRow+Math.max(1,Math.ceil(viewport.clientHeight/ROW_HEIGHT))-1,1,totalRows),visibleRight=clamp(visibleColumn+Math.max(1,Math.ceil(viewport.clientWidth/state.columnWidth))-1,1,totalColumns);let rowStart=state.rowStart,columnStart=state.columnStart;if(visibleRow<state.rowStart||visibleBottom>state.rowEnd)rowStart=Math.floor((visibleRow-1)/ROW_STRIDE)*ROW_STRIDE+1;else if(state.rowEnd<totalRows&&visibleBottom+ROW_PREFETCH_MARGIN>=state.rowEnd)rowStart=Math.min(totalRows,state.rowStart+ROW_STRIDE);else if(state.rowStart>1&&visibleRow-ROW_PREFETCH_MARGIN<=state.rowStart)rowStart=Math.max(1,state.rowStart-ROW_STRIDE);if(visibleColumn<state.columnStart||visibleRight>state.columnEnd)columnStart=Math.floor((visibleColumn-1)/COLUMN_STRIDE)*COLUMN_STRIDE+1;else if(state.columnEnd<totalColumns&&visibleRight+COLUMN_PREFETCH_MARGIN>=state.columnEnd)columnStart=Math.min(totalColumns,state.columnStart+COLUMN_STRIDE);else if(state.columnStart>1&&visibleColumn-COLUMN_PREFETCH_MARGIN<=state.columnStart)columnStart=Math.max(1,state.columnStart-COLUMN_STRIDE);if(rowStart!==state.rowStart||columnStart!==state.columnStart)requestPage(rowStart,columnStart,'prefetch');},60);});
function normalizeSelection(selection){return{rowStart:Math.min(selection.rowStart,selection.rowEnd),rowEnd:Math.max(selection.rowStart,selection.rowEnd),columnStart:Math.min(selection.columnStart,selection.columnEnd),columnEnd:Math.max(selection.columnStart,selection.columnEnd)};}
function setSelection(row,column,extend){if(!state.metadata)return;if(!extend||!state.anchor)state.anchor={row,column};state.active={row,column};state.selection=normalizeSelection({rowStart:state.anchor.row,rowEnd:row,columnStart:state.anchor.column,columnEnd:column});applySelection();}
function applySelection(){document.querySelectorAll('.data-cell').forEach(cell=>{const row=Number(cell.dataset.row),column=Number(cell.dataset.column),selected=state.selection&&row>=state.selection.rowStart&&row<=state.selection.rowEnd&&column>=state.selection.columnStart&&column<=state.selection.columnEnd;cell.classList.toggle('selected',Boolean(selected));cell.classList.toggle('active',Boolean(state.active&&row===state.active.row&&column===state.active.column));});el('copyButton').disabled=!state.selection;if(!state.selection){el('selectionStatus').textContent='No selection';return;}const selection=state.selection,rowPart=selection.rowStart===selection.rowEnd?selection.rowStart:selection.rowStart+':'+selection.rowEnd,columnPart=selection.columnStart===selection.columnEnd?selection.columnStart:selection.columnStart+':'+selection.columnEnd,suffix=state.pages.map(index=>','+index).join('');el('selectionStatus').textContent=variable+'('+rowPart+', '+columnPart+suffix+') · '+((selection.rowEnd-selection.rowStart+1)*(selection.columnEnd-selection.columnStart+1))+' cells';}
function selectHeaderRange(type,index){if(type==='row'){state.anchor={row:index,column:1};state.active={row:index,column:state.metadata.size[1]||1};state.selection={rowStart:index,rowEnd:index,columnStart:1,columnEnd:state.metadata.size[1]||1};}else{state.anchor={row:1,column:index};state.active={row:state.metadata.size[0]||1,column:index};state.selection={rowStart:1,rowEnd:state.metadata.size[0]||1,columnStart:index,columnEnd:index};}applySelection();}
el('cellLayer').addEventListener('pointerdown',event=>{const cell=event.target.closest('.data-cell');if(!cell)return;state.dragging=true;setSelection(Number(cell.dataset.row),Number(cell.dataset.column),event.shiftKey);el('matrixViewport').focus();event.preventDefault();});el('cellLayer').addEventListener('pointerover',event=>{if(!state.dragging)return;const cell=event.target.closest('.data-cell');if(cell)setSelection(Number(cell.dataset.row),Number(cell.dataset.column),true);});addEventListener('pointerup',()=>{state.dragging=false;});
el('cellLayer').addEventListener('dblclick',event=>{const cell=event.target.closest('.data-cell');if(!cell)return;const row=Number(cell.dataset.row)-state.rowStart,column=Number(cell.dataset.column)-state.columnStart,matrix=matrixOf(state.values,state.rowEnd-state.rowStart+1,state.columnEnd-state.columnStart+1),value=matrix[row]?.[column];if(value&&typeof value==='object'){const globalRow=row+state.rowStart,globalColumn=column+state.columnStart;resetDrawer();state.drawerCell={row:globalRow,column:globalColumn,pages:[...state.pages]};renderDrawer(value,globalRow,globalColumn);}});
el('columnHeaderLayer').addEventListener('click',event=>{const header=event.target.closest('.header-cell');if(header)selectHeaderRange('column',Number(header.dataset.column));});el('rowHeaderLayer').addEventListener('click',event=>{const header=event.target.closest('.row-header');if(header)selectHeaderRange('row',Number(header.dataset.row));});el('corner').onclick=()=>{if(!state.metadata)return;state.anchor={row:1,column:1};state.active={row:state.metadata.size[0]||1,column:state.metadata.size[1]||1};state.selection={rowStart:1,rowEnd:state.metadata.size[0]||1,columnStart:1,columnEnd:state.metadata.size[1]||1};applySelection();};
function copySelection(){if(!state.selection)return;vscode.postMessage({type:'copySelection',selection:state.selection,pages:state.pages});}
function ensureActiveVisible(){if(!state.active)return;const viewport=el('matrixViewport'),top=HEADER_HEIGHT+(state.active.row-1)*ROW_HEIGHT,left=ROW_HEADER_WIDTH+(state.active.column-1)*state.columnWidth;if(top<viewport.scrollTop+HEADER_HEIGHT)viewport.scrollTop=Math.max(0,top-HEADER_HEIGHT);else if(top+ROW_HEIGHT>viewport.scrollTop+viewport.clientHeight)viewport.scrollTop=top+ROW_HEIGHT-viewport.clientHeight;if(left<viewport.scrollLeft+ROW_HEADER_WIDTH)viewport.scrollLeft=Math.max(0,left-ROW_HEADER_WIDTH);else if(left+state.columnWidth>viewport.scrollLeft+viewport.clientWidth)viewport.scrollLeft=left+state.columnWidth-viewport.clientWidth;}
el('matrixViewport').addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='c'){event.preventDefault();copySelection();return;}if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='a'){event.preventDefault();el('corner').click();return;}if(event.key==='Escape'){state.selection=null;state.anchor=null;state.active=null;applySelection();return;}const directions={ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,-1],ArrowRight:[0,1]},direction=directions[event.key];if(!direction||!state.metadata)return;event.preventDefault();const current=state.active||{row:state.rowStart,column:state.columnStart},row=clamp(current.row+direction[0],1,state.metadata.size[0]||1),column=clamp(current.column+direction[1],1,state.metadata.size[1]||1);setSelection(row,column,event.shiftKey);ensureActiveVisible();});
function showToast(message,isError){const toast=el('toast');toast.textContent=message;toast.style.color=isError?'var(--vscode-errorForeground)':'';toast.classList.add('visible');setTimeout(()=>toast.classList.remove('visible'),1800);}
el('prevRows').onclick=()=>goTo(state.rowStart-ROW_STRIDE,state.columnStart);el('nextRows').onclick=()=>goTo(state.rowStart+ROW_STRIDE,state.columnStart);el('prevCols').onclick=()=>goTo(state.rowStart,state.columnStart-COLUMN_STRIDE);el('nextCols').onclick=()=>goTo(state.rowStart,state.columnStart+COLUMN_STRIDE);
el('numberFormat').onchange=()=>{state.numberFormat=el('numberFormat').value;el('precision').hidden=state.numberFormat!=='custom';persist();state.source='manual';usesInspector()?renderInspector():renderMatrix();};el('precision').onchange=()=>{state.precision=clamp(Number(el('precision').value)||0,0,15);persist();state.source='manual';usesInspector()?renderInspector():renderMatrix();};el('precision').value=state.precision;
el('fitColumns').onclick=()=>{if(!state.values)return;const flat=matrixOf(state.values,state.rowEnd-state.rowStart+1,state.columnEnd-state.columnStart+1).flat(),headerLength=state.columnNames.reduce((max,label)=>Math.max(max,label.length),3),longest=flat.reduce((max,value)=>Math.max(max,(isScalar(value)?scalarText(value):describe(value)).length),headerLength);state.columnWidth=clamp(longest*8+24,72,320);updateCssMetrics();persist();usesInspector()?renderInspector():renderMatrix();};
el('copyButton').onclick=copySelection;el('autoButton').onclick=()=>{state.autoRefresh=!state.autoRefresh;persist();updateToolbar();vscode.postMessage({type:'autoRefresh',enabled:state.autoRefresh});};el('closeDrawer').onclick=resetDrawer;
addEventListener('message',event=>{const message=event.data;if(message.type==='data')render(message);else if(message.type==='error'){state.pendingKey='';el('loading').hidden=true;if(message.source==='prefetch'||message.source==='scroll')showToast(message.message||'Background load failed',true);else{el('inspector').hidden=false;el('matrixViewport').hidden=true;el('inspector').innerHTML='<div class="error">'+escapeHtml(message.message)+'</div>';}}else if(message.type==='copyComplete')showToast(message.message||'Copied',false);else if(message.type==='copyError')showToast(message.message||'Copy failed',true);});
updateCssMetrics();el('numberFormat').value=state.numberFormat;el('precision').value=state.precision;el('precision').hidden=state.numberFormat!=='custom';el('autoButton').classList.toggle('paused',!state.autoRefresh);el('autoLabel').textContent=state.autoRefresh?'Auto':'Paused';vscode.postMessage({type:'ready',autoRefresh:state.autoRefresh});
</script>
</body>
</html>`
}
