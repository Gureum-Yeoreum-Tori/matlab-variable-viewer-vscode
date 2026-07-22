// Copyright 2026 The MathWorks, Inc.

import { expect } from 'chai'
import { JSDOM } from 'jsdom'
import {
    boundValueForWebview,
    getVariableEditorHtml,
    isVariableEditorWebviewMessage,
    parseMda,
    sliceFingerprintSignatures,
    tablePayloadToGrid,
    valuesToTsv,
    VARIABLE_PAGE_ROWS,
    VARIABLE_PAGE_COLUMNS,
    VARIABLE_PAGE_ROW_STRIDE,
    VARIABLE_PAGE_COLUMN_STRIDE
} from '../../workspacebrowser/variableEditor'

interface PostedMessage {
    type: string
    expression?: string
    enabled?: boolean
    selection?: Record<string, number>
    rowStart?: number
    columnStart?: number
    pages?: number[]
    source?: string
}

function createEditorDom (name: string): { dom: JSDOM, postedMessages: PostedMessage[] } {
    const html = getVariableEditorHtml(name)
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost', pretendToBeVisual: true })
    const postedMessages: PostedMessage[] = []
    const state: Record<string, unknown> = {}
    const testWindow = dom.window as unknown as {
        acquireVsCodeApi: () => {
            postMessage: (message: PostedMessage) => void
            getState: () => Record<string, unknown>
            setState: (next: Record<string, unknown>) => void
        }
    }
    testWindow.acquireVsCodeApi = () => ({
        postMessage: message => { postedMessages.push(message) },
        getState: () => state,
        setState: next => { Object.assign(state, next) }
    })
    const script = html.match(/<script(?: nonce="[^"]+")?>([\s\S]*)<\/script>/)?.[1]
    if (script == null) throw new Error('Variable editor script is missing')
    dom.window.eval(script)
    return { dom, postedMessages }
}

function sendData (dom: JSDOM, data: Record<string, unknown>): void {
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'data', ...data } }))
}

suite('variable editor', () => {
    test('decodes column-major numeric and cell MDA values without JSON flattening', () => {
        expect(parseMda({
            mwtype: 'double',
            mwsize: [2, 3],
            mwdata: [1, 2, 3, 4, 5, 6]
        })).to.deep.equal([[1, 3, 5], [2, 4, 6]])
        expect(parseMda({
            mwtype: 'cell',
            mwsize: [2, 2],
            mwdata: [
                { mwtype: 'double', mwsize: [1, 1], mwdata: [1] },
                { mwtype: 'double', mwsize: [1, 1], mwdata: [2] },
                { mwtype: 'char', mwsize: [1, 1], mwdata: ['A'] },
                { mwtype: 'char', mwsize: [1, 1], mwdata: ['B'] }
            ]
        })).to.deep.equal([[1, 'A'], [2, 'B']])
    })

    test('converts serialized table row records into a rectangular grid', () => {
        expect(tablePayloadToGrid({
            columnNames: ['Index', 'Value', 'Group'],
            rowNames: ['first', 'second'],
            rows: [
                { Index: 1, Value: 0.5, Group: 'A' },
                { Index: 2, Value: 0.75, Group: 'B' }
            ]
        })).to.deep.equal({
            columnNames: ['Index', 'Value', 'Group'],
            rowNames: ['first', 'second'],
            values: [[1, 0.5, 'A'], [2, 0.75, 'B']]
        })
    })

    test('builds stable per-slice signatures from MATLAB fingerprint metrics', () => {
        expect(sliceFingerprintSignatures({
            sumReal: [10, 20],
            sumImag: [0, 0],
            sumAbs: [10, 20],
            weightedReal: [30, 60],
            weightedImag: [0, 0],
            nanCount: [0, 1]
        }, 2)).to.deep.equal([
            '[10,0,10,30,0,0]',
            '[20,0,20,60,0,1]'
        ])
    })

    test('serializes matrix selections as TSV', () => {
        expect(valuesToTsv([[1, 2], [3, 4]], 2, 2)).to.equal('1\t2\n3\t4')
    })

    test('preserves row and column vector orientation', () => {
        expect(valuesToTsv([1, 2, 3], 1, 3)).to.equal('1\t2\t3')
        expect(valuesToTsv([1, 2, 3], 3, 1)).to.equal('1\n2\n3')
    })

    test('quotes structured and multiline values for TSV', () => {
        expect(valuesToTsv([{ field: 1 }, 'a\nb'], 1, 2)).to.equal('"{""field"":1}"\t"a\nb"')
    })

    test('includes buffered grid, formatting, copy, dimension, and auto-refresh controls', () => {
        const html = getVariableEditorHtml('sample.matrix')
        expect(html).to.include('id="matrixViewport"')
        expect(html).to.include('id="numberFormat"')
        expect(html).to.include('id="copyButton"')
        expect(html).to.include('id="autoButton"')
        expect(html).to.include('id="dimensionBar"')
        expect(html).to.include(`PAGE_ROWS=${VARIABLE_PAGE_ROWS}`)
        expect(html).to.include(`PAGE_COLUMNS=${VARIABLE_PAGE_COLUMNS}`)
        expect(html).to.include(`ROW_STRIDE=${VARIABLE_PAGE_ROW_STRIDE}`)
        expect(html).to.include(`COLUMN_STRIDE=${VARIABLE_PAGE_COLUMN_STRIDE}`)
    })

    test('safely embeds a validated MATLAB expression', () => {
        const html = getVariableEditorHtml('root.nested')
        expect(html).to.include('const variable="root.nested";')
    })

    test('applies a nonce Content Security Policy to the variable editor', () => {
        const html = getVariableEditorHtml('sample', 'test-nonce')
        expect(html).to.include("default-src 'none'")
        expect(html).to.include("script-src 'nonce-test-nonce'")
        expect(html).to.include('<style nonce="test-nonce">')
        expect(html).to.include('<script nonce="test-nonce">')
    })

    test('runtime-validates messages received from the webview', () => {
        expect(isVariableEditorWebviewMessage({ type: 'page', rowStart: 1, columnStart: 1, pages: [2], source: 'manual' })).to.equal(true)
        expect(isVariableEditorWebviewMessage({ type: 'copySelection', selection: { rowStart: 1, rowEnd: 2, columnStart: 1, columnEnd: 2 }, pages: [] })).to.equal(true)
        expect(isVariableEditorWebviewMessage({ type: 'page', rowStart: Number.NaN, columnStart: 1, pages: [] })).to.equal(false)
        expect(isVariableEditorWebviewMessage({ type: 'page', rowStart: 1, columnStart: 1, pages: [-1] })).to.equal(false)
        expect(isVariableEditorWebviewMessage({ type: 'openNested', expression: "safe;system('bad')" })).to.equal(false)
    })

    test('bounds structured values by depth and node count', () => {
        expect(boundValueForWebview({ a: { b: { c: 1 } } }, 2)).to.deep.equal({ a: { b: '[Truncated: maximum depth reached]' } })
        expect(boundValueForWebview([1, 2, 3, 4], 8, 3)).to.deep.equal([1, 2, '[Truncated: value limit reached]', '[Truncated: value limit reached]'])
    })

    test('renders a virtual matrix grid and posts selection actions', () => {
        const { dom, postedMessages } = createEditorDom('v1')
        sendData(dom, {
            metadata: { name: 'v1', class: 'double', size: [2, 2] },
            values: [[1, 2], [3, 4]],
            rowStart: 1,
            rowEnd: 2,
            columnStart: 1,
            columnEnd: 2,
            pageIndices: [],
            source: 'initial',
            updatedAt: Date.now()
        })
        expect(dom.window.document.querySelectorAll('.data-cell')).to.have.length(4)
        const firstCell = dom.window.document.querySelector('.data-cell')
        firstCell?.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }))
        ;(dom.window.document.querySelector('#copyButton') as HTMLButtonElement).click()
        expect(postedMessages.some(message => message.type === 'copySelection')).to.equal(true)
        ;(dom.window.document.querySelector('#autoButton') as HTMLButtonElement).click()
        expect(postedMessages.some(message => message.type === 'autoRefresh' && message.enabled === false)).to.equal(true)
        dom.window.close()
    })

    test('renders table variable names and row labels without flattening columns', () => {
        const { dom } = createEditorDom('tableData')
        sendData(dom, {
            metadata: { name: 'tableData', class: 'table', size: [2, 3] },
            values: [[1, 0.5, 'A'], [2, 0.75, 'B']],
            columnNames: ['Index', 'Value', 'Group'],
            rowNames: ['sample-1', 'sample-2'],
            rowStart: 1,
            rowEnd: 2,
            columnStart: 1,
            columnEnd: 3,
            pageIndices: [],
            source: 'initial'
        })
        expect(Array.from(dom.window.document.querySelectorAll('.header-cell')).map(cell => cell.textContent)).to.deep.equal(['Index', 'Value', 'Group'])
        expect(Array.from(dom.window.document.querySelectorAll('.row-header')).map(cell => cell.textContent)).to.deep.equal(['sample-1', 'sample-2'])
        expect(dom.window.document.querySelectorAll('.data-cell')).to.have.length(6)
        dom.window.close()
    })

    test('keeps a large buffered matrix virtualized in the DOM', () => {
        const { dom } = createEditorDom('largeMatrix')
        const values = Array.from({ length: VARIABLE_PAGE_ROWS }, (_, row) =>
            Array.from({ length: VARIABLE_PAGE_COLUMNS }, (_, column) => row * VARIABLE_PAGE_COLUMNS + column)
        )
        sendData(dom, {
            metadata: { name: 'largeMatrix', class: 'double', size: [512, 512] },
            values,
            rowStart: 1,
            rowEnd: VARIABLE_PAGE_ROWS,
            columnStart: 1,
            columnEnd: VARIABLE_PAGE_COLUMNS,
            pageIndices: [],
            source: 'initial'
        })
        expect(dom.window.document.querySelectorAll('.data-cell').length).to.be.lessThan(1000)
        expect(dom.window.document.querySelectorAll('.data-cell').length).to.be.greaterThan(0)
        dom.window.close()
    })

    test('renders structure field summaries and opens nested fields', () => {
        const { dom, postedMessages } = createEditorDom('v5')
        sendData(dom, {
            metadata: { name: 'v5', class: 'struct', size: [1, 1] },
            values: { n1: [[1, 2], [3, 4]], scalar: 5 },
            rowStart: 1,
            rowEnd: 1,
            columnStart: 1,
            columnEnd: 1,
            pageIndices: [],
            source: 'initial'
        })
        expect(dom.window.document.querySelector('#inspector')?.textContent).to.include('2×2 number')
        ;(dom.window.document.querySelector('.open-field') as HTMLButtonElement).click()
        expect(postedMessages.some(message => message.type === 'openNested' && message.expression === 'v5.n1')).to.equal(true)
        dom.window.close()
    })

    test('preserves expanded scalar-structure fields and marks changed descendants', () => {
        const { dom } = createEditorDom('v5')
        const base = {
            metadata: { name: 'v5', class: 'struct', size: [1, 1] },
            rowStart: 1,
            rowEnd: 1,
            columnStart: 1,
            columnEnd: 1,
            pageIndices: []
        }
        sendData(dom, { ...base, values: { n1: [[1, 2], [3, 4]], n2: [[5, 6]] }, source: 'initial' })
        const n1 = dom.window.document.querySelector('details[data-path="$.n1"]') as HTMLDetailsElement
        const n2 = dom.window.document.querySelector('details[data-path="$.n2"]') as HTMLDetailsElement
        n1.open = true
        n2.open = true
        sendData(dom, { ...base, values: { n1: [[9, 2], [3, 4]], n2: [[5, 7]] }, source: 'auto' })
        expect((dom.window.document.querySelector('details[data-path="$.n1"]') as HTMLDetailsElement).open).to.equal(true)
        expect((dom.window.document.querySelector('details[data-path="$.n2"]') as HTMLDetailsElement).open).to.equal(true)
        expect(dom.window.document.querySelectorAll('details.branch-changed')).to.have.length(2)
        expect(dom.window.document.querySelectorAll('.change-badge')).to.have.length(2)
        expect(dom.window.document.querySelectorAll('.primitive.changed')).to.have.length(2)
        dom.window.close()
    })

    test('preserves multiple expanded levels in a nested scalar structure', () => {
        const { dom } = createEditorDom('v11')
        const base = {
            metadata: { name: 'v11', class: 'struct', size: [1, 1] },
            rowStart: 1,
            rowEnd: 1,
            columnStart: 1,
            columnEnd: 1,
            pageIndices: []
        }
        sendData(dom, {
            ...base,
            values: { nested: { matrix: [[1, 2], [3, 4]], deeper: { value: 5 } } },
            source: 'initial'
        })
        ;(dom.window.document.querySelector('details[data-path="$.nested"]') as HTMLDetailsElement).open = true
        ;(dom.window.document.querySelector('details[data-path="$.nested.deeper"]') as HTMLDetailsElement).open = true
        sendData(dom, {
            ...base,
            values: { nested: { matrix: [[9, 2], [3, 4]], deeper: { value: 6 } } },
            source: 'auto'
        })
        expect((dom.window.document.querySelector('details[data-path="$.nested"]') as HTMLDetailsElement).open).to.equal(true)
        expect((dom.window.document.querySelector('details[data-path="$.nested.deeper"]') as HTMLDetailsElement).open).to.equal(true)
        expect(dom.window.document.querySelector('details[data-path="$.nested"] .change-badge')?.textContent).to.equal('2 changed')
        dom.window.close()
    })

    test('highlights matrix cells changed by automatic refresh', () => {
        const { dom } = createEditorDom('v1')
        const base = {
            metadata: { name: 'v1', class: 'double', size: [1, 2] },
            rowStart: 1,
            rowEnd: 1,
            columnStart: 1,
            columnEnd: 2,
            pageIndices: []
        }
        sendData(dom, { ...base, values: [1, 2], source: 'initial' })
        sendData(dom, { ...base, values: [9, 2], source: 'auto' })
        expect(dom.window.document.querySelectorAll('.data-cell.changed')).to.have.length(1)
        dom.window.close()
    })

    test('prefetches the next overlapping row window near a loaded boundary', async () => {
        const { dom, postedMessages } = createEditorDom('largeMatrix')
        sendData(dom, {
            metadata: { name: 'largeMatrix', class: 'double', size: [500, 1] },
            values: [],
            rowStart: 1,
            rowEnd: VARIABLE_PAGE_ROWS,
            columnStart: 1,
            columnEnd: 1,
            pageIndices: [],
            source: 'initial'
        })
        const viewport = dom.window.document.querySelector('#matrixViewport') as HTMLDivElement
        Object.defineProperty(viewport, 'clientHeight', { value: 280 })
        Object.defineProperty(viewport, 'clientWidth', { value: 400 })
        viewport.scrollTop = 28 + 134 * 28
        viewport.dispatchEvent(new dom.window.Event('scroll'))
        await new Promise(resolve => setTimeout(resolve, 100))
        const prefetch = postedMessages.find(message => message.type === 'page' && message.source === 'prefetch')
        expect(prefetch?.rowStart).to.equal(1 + VARIABLE_PAGE_ROW_STRIDE)
        expect((dom.window.document.querySelector('#loading') as HTMLElement).hidden).to.equal(true)
        dom.window.close()
    })

    test('loads the window containing a distant scrollbar jump directly', async () => {
        const { dom, postedMessages } = createEditorDom('largeMatrix')
        sendData(dom, {
            metadata: { name: 'largeMatrix', class: 'double', size: [512, 512] },
            values: [],
            rowStart: 1,
            rowEnd: VARIABLE_PAGE_ROWS,
            columnStart: 1,
            columnEnd: VARIABLE_PAGE_COLUMNS,
            pageIndices: [],
            source: 'initial'
        })
        const viewport = dom.window.document.querySelector('#matrixViewport') as HTMLDivElement
        Object.defineProperty(viewport, 'clientHeight', { value: 280 })
        Object.defineProperty(viewport, 'clientWidth', { value: 400 })
        viewport.scrollTop = 28 + 399 * 28
        viewport.scrollLeft = 58 + 359 * 112
        viewport.dispatchEvent(new dom.window.Event('scroll'))
        await new Promise(resolve => setTimeout(resolve, 100))
        const prefetch = postedMessages.find(message => message.type === 'page' && message.source === 'prefetch')
        expect(prefetch?.rowStart).to.equal(1 + 4 * VARIABLE_PAGE_ROW_STRIDE)
        expect(prefetch?.columnStart).to.equal(1 + 11 * VARIABLE_PAGE_COLUMN_STRIDE)
        dom.window.close()
    })

    test('keeps higher-dimension navigation visible with explicit step buttons', () => {
        const { dom, postedMessages } = createEditorDom('tensor')
        sendData(dom, {
            metadata: { name: 'tensor', class: 'double', size: [1, 1, 3, 2] },
            values: 1,
            rowStart: 1,
            rowEnd: 1,
            columnStart: 1,
            columnEnd: 1,
            pageIndices: [1, 1],
            source: 'initial'
        })
        expect((dom.window.document.querySelector('#dimensionBar') as HTMLElement).hidden).to.equal(false)
        expect(dom.window.document.querySelectorAll('.dimension-control')).to.have.length(2)
        const nextDim3 = dom.window.document.querySelector('.dimension-step[data-dimension="0"][data-step="1"]') as HTMLButtonElement
        nextDim3.click()
        const request = postedMessages.find(message => message.type === 'page')
        expect(request?.pages).to.deep.equal([2, 1])
        expect(request?.source).to.equal('manual')
        dom.window.close()
    })

    test('marks a changed hidden higher-dimensional slice and opens it from the slice strip', () => {
        const { dom, postedMessages } = createEditorDom('tensor')
        const base = {
            metadata: { name: 'tensor', class: 'double', size: [2, 2, 3] },
            values: [[1, 2], [3, 4]],
            rowStart: 1,
            rowEnd: 2,
            columnStart: 1,
            columnEnd: 2,
            pageIndices: [1]
        }
        sendData(dom, { ...base, sliceSignatures: ['slice-1', 'slice-2', 'slice-3'], source: 'initial' })
        sendData(dom, { ...base, sliceSignatures: ['slice-1', 'slice-2-updated', 'slice-3'], source: 'auto' })
        const changedSlice = dom.window.document.querySelector('.slice-chip.changed[data-slice="1"]') as HTMLButtonElement
        expect(changedSlice).not.to.equal(null)
        changedSlice.click()
        const request = postedMessages.find(message => message.type === 'page')
        expect(request?.pages).to.deep.equal([2])
        expect(request?.source).to.equal('manual')
        dom.window.close()
    })

    test('highlights values changed while a previously visited dimension page was hidden', () => {
        const { dom } = createEditorDom('tensor')
        const base = {
            metadata: { name: 'tensor', class: 'double', size: [1, 2, 2] },
            rowStart: 1,
            rowEnd: 1,
            columnStart: 1,
            columnEnd: 2
        }
        sendData(dom, { ...base, values: [1, 2], pageIndices: [1], source: 'initial' })
        sendData(dom, { ...base, values: [10, 20], pageIndices: [2], source: 'manual' })
        sendData(dom, { ...base, values: [9, 2], pageIndices: [1], source: 'manual' })
        expect(dom.window.document.querySelectorAll('.data-cell.changed')).to.have.length(1)
        expect(dom.window.document.querySelector('#dimensionBar')?.classList.contains('changed')).to.equal(true)
        dom.window.close()
    })

    test('highlights changed values inside an open compound-cell drawer', () => {
        const { dom } = createEditorDom('cellData')
        const base = {
            metadata: { name: 'cellData', class: 'cell', size: [1, 1] },
            rowStart: 1,
            rowEnd: 1,
            columnStart: 1,
            columnEnd: 1,
            pageIndices: []
        }
        sendData(dom, { ...base, values: [{ matrix: [[1, 2], [3, 4]] }], source: 'initial' })
        dom.window.document.querySelector('.data-cell')?.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }))
        sendData(dom, { ...base, values: [{ matrix: [[9, 2], [3, 4]] }], source: 'auto' })
        expect(dom.window.document.querySelectorAll('#drawerContent .primitive.changed')).to.have.length(1)
        dom.window.close()
    })

    test('preserves an expanded drawer field and marks its changed descendants', () => {
        const { dom } = createEditorDom('v6')
        const base = {
            metadata: { name: 'v6', class: 'struct', size: [1, 3] },
            rowStart: 1,
            rowEnd: 1,
            columnStart: 1,
            columnEnd: 3,
            pageIndices: []
        }
        const values = [{ a: 1 }, { a: 2 }, { b: 3, c: [[1, 2], [3, 4]] }]
        sendData(dom, { ...base, values, source: 'initial' })
        dom.window.document.querySelector('.data-cell[data-column="3"]')?.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }))
        const c = dom.window.document.querySelector('#drawerContent details[data-path="$drawer.c"]') as HTMLDetailsElement
        c.open = true
        sendData(dom, {
            ...base,
            values: [{ a: 1 }, { a: 2 }, { b: 3, c: [[9, 2], [3, 4]] }],
            source: 'auto'
        })
        const refreshedC = dom.window.document.querySelector('#drawerContent details[data-path="$drawer.c"]') as HTMLDetailsElement
        expect(refreshedC.open).to.equal(true)
        expect(refreshedC.classList.contains('branch-changed')).to.equal(true)
        expect(refreshedC.querySelector('.change-badge')?.textContent).to.equal('1 changed')
        expect(refreshedC.querySelectorAll('.primitive.changed')).to.have.length(1)
        dom.window.close()
    })
})
