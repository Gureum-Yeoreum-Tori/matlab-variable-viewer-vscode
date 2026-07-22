// Copyright 2026 The MathWorks, Inc.

import * as vscode from 'vscode'
import * as crypto from 'crypto'
import BaseService from '../services/BaseService'
import { Notifier } from '../commandwindow/MultiClientNotifier'
import { MVM, MatlabMVMConnectionState } from '../commandwindow/MVM'
import Notification from '../notifications/Notifications'
import { WorkspaceVariable, WorkspaceColumn, SavedState, ExtToWebview } from './types'
import TelemetryLogger from '../services/telemetry/TelemetryLogger'
import { WSB_MINIMUM_RELEASE, getUnsupportedHtml, getDisconnectedHtml, getWebviewHtml } from './templates'
import {
    getVariableEditorHtml,
    boundValueForWebview,
    isVariableEditorWebviewMessage,
    parseMda,
    sliceFingerprintSignatures,
    tablePayloadToGrid,
    valuesToTsv,
    VariableMetadata,
    VARIABLE_PAGE_ROWS,
    VARIABLE_PAGE_COLUMNS,
    VARIABLE_COPY_CELL_LIMIT,
    VariableEditorWebviewMessage,
    VariableSelection
} from './variableEditor'

// Default cap on how many variables the workspace browser will request
export const WSB_DEFAULT_MAX_VARIABLES = 500

// Debounce interval for coalescing rapid DataChanged events from the server
const DATA_THROTTLE_MS = 300

const MAX_VARS_SETTING_ID = 'MATLAB.maximumWorkspaceVariables'
const SORT_METHOD_SETTING_ID = 'MATLAB.workspaceSortMethod'
const MAX_VARS_BUTTON_TEXT = 'Change Maximum Variable Count'
const MAX_VARIABLES_MESSAGE_TEMPLATE =
    'The MATLAB workspace contains {currentCount} variables, which exceeds the maximum ' +
    'number of variables to display in the Workspace panel ({maxVariables}).'

const WSB_STATE_KEY = 'wsb-state'
const DIRECT_MDA_CLASSES = new Set([
    'double', 'single',
    'int8', 'uint8', 'int16', 'uint16', 'int32', 'uint32', 'int64', 'uint64',
    'logical'
])
const JSON_VIEW_CLASSES = new Set([
    'char', 'string', 'cell', 'struct', 'table', 'timetable',
    'categorical', 'datetime', 'duration', 'calendarDuration'
])
const DIMENSION_FINGERPRINT_PAGE_LIMIT = 256
const DIMENSION_FINGERPRINT_ELEMENT_LIMIT = 2_000_000
const MAX_JSON_RESPONSE_CHARACTERS = 4_000_000
const MAX_CLIPBOARD_BYTES = 4_000_000

function isVariableMetadata (value: unknown): value is VariableMetadata {
    if (value == null || typeof value !== 'object') return false
    const metadata = value as Record<string, unknown>
    return typeof metadata.name === 'string' &&
        typeof metadata.class === 'string' &&
        Array.isArray(metadata.size) &&
        metadata.size.length >= 2 &&
        metadata.size.length <= 32 &&
        metadata.size.every(size => Number.isSafeInteger(size) && Number(size) >= 0)
}

// Shown immediately on webview load before the server sends column metadata.
// Order must match the server's GetVisibleColumns response: Name, Value, Size, Class.
const DEFAULT_COLUMNS: WorkspaceColumn[] = [
    { name: 'Name', label: 'Name', sortable: true, resizable: true },
    { name: 'Value', label: 'Value', sortable: false, resizable: true },
    { name: 'Size', label: 'Size', sortable: true, resizable: true },
    { name: 'Class', label: 'Class', sortable: true, resizable: true }
]

export default class WorkspaceBrowserProvider extends BaseService implements vscode.WebviewViewProvider {
    private view: vscode.WebviewView | undefined
    private cachedRows: WorkspaceVariable[] | undefined
    private cachedColumns: WorkspaceColumn[] | undefined
    private savedState: SavedState | undefined
    private numRows: number = 0
    private numColumns: number = 0

    // Throttle state for coalescing rapid DataChanged events
    private dataRequestPending: boolean = false
    private dataRequestTimer: ReturnType<typeof setTimeout> | undefined
    private variableEditorRefreshTimer: ReturnType<typeof setTimeout> | undefined
    private readonly variableEditorRefreshes = new Set<() => void>()
    private readonly variableEditorPanels = new Set<vscode.WebviewPanel>()
    private preferredVariableEditorPanel: vscode.WebviewPanel | undefined

    // Prevents duplicate max-variables warnings during a single connection session
    private maxVarsMessageShown: boolean = false

    constructor (
        private readonly extensionContext: vscode.ExtensionContext,
        private readonly notifier: Notifier,
        private readonly mvm: MVM,
        private readonly telemetryLogger: TelemetryLogger
    ) {
        super()

        // Restore persisted UI state (column widths, sort preferences)
        this.savedState = extensionContext.workspaceState.get<SavedState>(WSB_STATE_KEY)

        // Listen for workspace data from the MATLAB language server
        this.own(
            notifier.onNotification(Notification.WSBServerMessage, (msg: Record<string, unknown>) => {
                this.onServerMessage(msg)
            })
        )

        // React to MATLAB connection/disconnection events
        this.own(
            mvm.on(MVM.Events.stateChanged, (oldState: MatlabMVMConnectionState, newState: MatlabMVMConnectionState) => {
                this.onMatlabStateChanged(newState)
            })
        )

        // Re-render icons when the VS Code theme changes
        this.own(
            vscode.window.onDidChangeActiveColorTheme(() => {
                this.postToWebview({ type: 'themeChanged' })
            })
        )

        // Re-send sorted/capped data when the user changes the max variables setting
        this.own(
            vscode.workspace.onDidChangeConfiguration((event: vscode.ConfigurationChangeEvent) => {
                if (event.affectsConfiguration(MAX_VARS_SETTING_ID)) {
                    this.maxVarsMessageShown = false
                    this.checkMaxVariablesWarning()
                    this.sendDataToWebview()
                }
                if (event.affectsConfiguration(SORT_METHOD_SETTING_ID)) {
                    this.sendDataToWebview()
                }
            })
        )

        // Register commands for the native VS Code context menu on the webview
        this.own(
            vscode.commands.registerCommand('matlab.wsb.editValue', (context: { varName: string } | undefined) => {
                if (context?.varName == null) return
                this.postToWebview({ type: 'focusValueInput', variable: context.varName })
            }),
            vscode.commands.registerCommand('matlab.wsb.renameVariable', (context: { varName: string } | undefined) => {
                if (context?.varName == null) return
                this.postToWebview({ type: 'focusNameInput', variable: context.varName })
            }),
            vscode.commands.registerCommand('matlab.wsb.deleteVariable', (context: { varName: string } | undefined) => {
                if (context?.varName == null) return
                void this.handleDeleteVariable(context.varName)
            }),
            vscode.commands.registerCommand('matlab.wsb.sortAscending', (context: { columnName: string }) => {
                this.postToWebview({ type: 'sortFromContextMenu', column: context.columnName, direction: 'asc' })
            }),
            vscode.commands.registerCommand('matlab.wsb.sortDescending', (context: { columnName: string }) => {
                this.postToWebview({ type: 'sortFromContextMenu', column: context.columnName, direction: 'desc' })
            })
        )

        // If MATLAB is already connected when the provider is constructed, start immediately
        if (mvm.getMatlabState() === MatlabMVMConnectionState.CONNECTED) {
            this.onMatlabStateChanged(MatlabMVMConnectionState.CONNECTED)
        }
    }

    // ── WebviewViewProvider ───────────────────────────────────────────

    resolveWebviewView (
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        token: vscode.CancellationToken
    ): void {
        this.view = webviewView

        this.telemetryLogger.logEvent({
            eventKey: 'ML_VS_CODE_ACTIONS',
            data: { action_type: 'wsbPanelOpened', result: '' }
        })

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionContext.extensionUri]
        }

        // Render appropriate HTML based on current connection state
        if (this.mvm.getMatlabState() === MatlabMVMConnectionState.CONNECTED) {
            if (WorkspaceBrowserProvider.isSupported(this.mvm.getMatlabRelease())) {
                webviewView.webview.html = getWebviewHtml(webviewView.webview, this.extensionContext.extensionUri)
            } else {
                webviewView.webview.html = getUnsupportedHtml()
            }
        } else {
            webviewView.webview.html = getDisconnectedHtml()
        }

        // Route messages from the webview to the handler
        this.own(
            webviewView.webview.onDidReceiveMessage((msg: Record<string, unknown>) => {
                this.onWebviewMessage(msg)
            })
        )

        webviewView.onDidDispose(() => {
            this.telemetryLogger.logEvent({
                eventKey: 'ML_VS_CODE_ACTIONS',
                data: { action_type: 'wsbPanelClosed', result: '' }
            })
        })
    }

    // ── MATLAB Lifecycle ─────────────────────────────────────────────

    private onMatlabStateChanged (newState: MatlabMVMConnectionState): void {
        if (newState === MatlabMVMConnectionState.CONNECTED) {
            this.onMatlabConnected()
        } else {
            this.onMatlabDisconnected()
        }
    }

    private onMatlabConnected (): void {
        if (!WorkspaceBrowserProvider.isSupported(this.mvm.getMatlabRelease())) {
            if (this.view != null) {
                this.view.webview.html = getUnsupportedHtml()
            }
            return
        }

        // Refresh the webview HTML so the script and styles are loaded
        if (this.view != null) {
            this.view.webview.html = getWebviewHtml(this.view.webview, this.extensionContext.extensionUri)
        }

        // Start the MATLAB workspace browser backend
        void this.mvm.eval(
            'internal.matlab.desktop_workspacebrowser.MobileWorkspaceBrowser.startup;',
            false
        )

        // Request initial workspace size from the language server
        this.notifier.sendNotification(Notification.WSBClientMessage, { type: 'GetSize' })
    }

    private onMatlabDisconnected (): void {
        // Clear all cached data so stale values are never shown after reconnection
        this.cachedRows = undefined
        this.cachedColumns = undefined
        this.numRows = 0
        this.numColumns = 0
        this.maxVarsMessageShown = false
        this.cancelPendingDataRequest()

        if (this.view != null) {
            this.view.webview.html = getDisconnectedHtml()
        }
    }

    // ── Version Gate ─────────────────────────────────────────────────

    // Returns true if the given MATLAB release string meets the minimum version for workspace browser
    static isSupported (release: string | null): boolean {
        if (release == null || release === '') return false
        return release >= WSB_MINIMUM_RELEASE
    }

    // Begins with a letter, contains only alphanumeric/underscore, max 2048 characters
    static isValidMatlabIdentifier (name: string): boolean {
        return name.length > 0 && name.length <= 2048 && (/^[a-zA-Z]\w*$/).test(name)
    }

    // ── Server Message Handling ──────────────────────────────────────

    private onServerMessage (msg: Record<string, unknown>): void {
        if (msg?.type == null) return

        switch (msg.type) {
            case 'Size':
                this.handleSizeMessage(msg)
                break
            case 'Columns':
                this.handleColumnsMessage(msg)
                break
            case 'Data':
                this.handleDataMessage(msg)
                break
            case 'DataChanged':
                this.handleDataChangedMessage(msg)
                break
            case 'InternalError':
                console.error('Workspace Browser server error:', msg.message)
                break
            case 'WorkspaceBrowserStarted':
                this.notifier.sendNotification(Notification.WSBClientMessage, { type: 'GetSize' })
                this.notifier.sendNotification(Notification.WSBClientMessage, { type: 'GetVisibleColumns' })
                break
        }
    }

    private handleSizeMessage (msg: Record<string, unknown>): void {
        this.updateSizeAndColumns(msg.rowCount, msg.columnCount)
        this.checkMaxVariablesWarning()
        this.scheduleDataRequest()
    }

    private handleColumnsMessage (msg: Record<string, unknown>): void {
        const rawColumns = msg.columns as Array<Record<string, unknown>>
        if (rawColumns == null) return

        // Server sends 'column'; legacy format sent 'name'/'Name'. The fallback
        // chain accommodates both without requiring a server version check.
        this.cachedColumns = rawColumns.map((col: Record<string, unknown>): WorkspaceColumn => {
            const colName = String(col.column ?? col.name ?? col.Name ?? '')
            return {
                name: colName,
                label: String(col.label ?? col.Label ?? colName),
                sortable: colName !== 'Value',
                resizable: true
            }
        })

        this.postToWebview({ type: 'setColumns', columns: this.cachedColumns })
    }

    private handleDataMessage (msg: Record<string, unknown>): void {
        const rawData = msg.data as Array<Record<string, unknown>>
        if (rawData == null) return

        // Build a column-name → index map for extracting named fields from positional data
        const colIndex: Record<string, number> = {}
        if (this.cachedColumns != null) {
            this.cachedColumns.forEach((col: WorkspaceColumn, i: number) => { colIndex[col.name] = i })
        }

        this.cachedRows = rawData.map((row: Record<string, unknown>): WorkspaceVariable => {
            const fields: Record<string, string> = {}
            const dataArray = row.data as unknown[] | undefined

            if (dataArray != null && this.cachedColumns != null) {
                // Primary format: server sends { data: [val0, val1, ...], rowNum: N }
                // where the data array is positional, matching the cached column order.
                for (const col of this.cachedColumns) {
                    fields[col.name] = String(dataArray[colIndex[col.name]] ?? '')
                }
            } else {
                // Fallback: flat object with named fields (when columns haven't arrived yet
                // or the server uses the legacy per-field format instead of positional arrays)
                for (const key of Object.keys(row)) {
                    if (key === 'data' || key === 'rowNum') continue
                    fields[key] = String(row[key] ?? '')
                }
            }

            return { name: fields.Name ?? '', fields }
        })

        this.sendDataToWebview()
    }

    private handleDataChangedMessage (msg: Record<string, unknown>): void {
        if (msg.columnCount !== undefined) {
            this.updateSizeAndColumns(msg.rowCount, msg.columnCount)
        }

        this.checkMaxVariablesWarning()
        this.scheduleDataRequest()
        this.scheduleVariableEditorRefresh()
    }

    // Shared logic for updating cached row/column counts from Size and DataChanged messages
    private updateSizeAndColumns (rawRowCount: unknown, rawColumnCount: unknown): void {
        const parsedColumnCount = Number(rawColumnCount)
        const newColumnCount = Math.max(0, Math.floor(Number.isNaN(parsedColumnCount) ? 0 : parsedColumnCount))
        if (newColumnCount !== this.numColumns) {
            this.notifier.sendNotification(Notification.WSBClientMessage, { type: 'GetVisibleColumns' })
        }
        const parsedRowCount = Number(rawRowCount)
        this.numRows = Math.max(0, Math.floor(Number.isNaN(parsedRowCount) ? 0 : parsedRowCount))
        this.numColumns = newColumnCount
    }

    // ── Webview Message Handling ─────────────────────────────────────

    private onWebviewMessage (msg: Record<string, unknown>): void {
        switch (msg.type) {
            case 'ready':
                this.handleWebviewReady()
                break
            case 'editValue':
                void this.handleEditValue(msg.variable as string, msg.newValue as string)
                break
            case 'renameVariable':
                void this.handleRenameVariable(msg.variable as string, msg.newName as string)
                break
            case 'deleteVariable':
                void this.handleDeleteVariable(msg.variable as string)
                break
            case 'stateChanged':
                this.handleStateChanged(msg.state as SavedState)
                break
            case 'openVariable':
                void this.openVariableEditor(msg.variable as string)
                break
            case 'openMaxVariablesSetting':
                void vscode.commands.executeCommand('workbench.action.openSettings', MAX_VARS_SETTING_ID)
                break
        }
    }

    private async openVariableEditor (variableExpression: string): Promise<void> {
        if (!/^[A-Za-z]\w*(?:\.[A-Za-z]\w*)*$/.test(variableExpression)) return
        const existingPanel = this.preferredVariableEditorPanel ?? this.variableEditorPanels.values().next().value
        const targetColumn = existingPanel?.viewColumn ?? vscode.ViewColumn.Beside
        const panel = vscode.window.createWebviewPanel('matlabVariableEditor', `MATLAB: ${variableExpression}`, targetColumn, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: []
        })
        this.variableEditorPanels.add(panel)
        this.preferredVariableEditorPanel = panel
        let metadata: VariableMetadata | undefined
        let currentPage = { rowStart: 1, columnStart: 1, pages: [] as number[] }
        let sliceSignatures: string[] = []
        let requestId = 0
        let loadRunning = false
        let autoRefreshEnabled = true
        let refreshPendingWhileHidden = false
        type LoadSource = 'initial' | 'manual' | 'scroll' | 'prefetch' | 'auto'
        interface LoadRequest {
            id: number
            rowStart: number
            columnStart: number
            pages: number[]
            refreshMetadata: boolean
            source: LoadSource
        }
        let pendingLoad: LoadRequest | undefined

        const evaluateMda = async (expression: string): Promise<unknown> => {
            let timeoutHandle: ReturnType<typeof setTimeout> | undefined
            const request = this.mvm.feval('evalin', 1, ['base', expression], false)
            const timeout = new Promise<never>((resolve, reject) => {
                timeoutHandle = setTimeout(() => reject(new Error('Timed out after 5 seconds')), 5000)
            })
            try {
                const response = await Promise.race([request, timeout])
                if (!('result' in response)) throw new Error(this.extractErrorMessage(response.error))
                return parseMda(response.result[0])
            } finally {
                if (timeoutHandle != null) clearTimeout(timeoutHandle)
            }
        }

        const evaluateJson = async (expression: string): Promise<unknown> => {
            const decoded = await evaluateMda(`feval(@(s)s(1:min(numel(s),${MAX_JSON_RESPONSE_CHARACTERS + 1})),jsonencode(${expression}))`)
            const json = Array.isArray(decoded) ? decoded.join('') : String(decoded)
            if (json.length > MAX_JSON_RESPONSE_CHARACTERS) {
                throw new Error(`Variable data exceeds the ${Math.round(MAX_JSON_RESPONSE_CHARACTERS / 1_000_000)} MB viewer limit`)
            }
            return JSON.parse(json)
        }

        const loadPage = async (loadRequest: LoadRequest): Promise<void> => {
            const { id: thisRequestId, rowStart, columnStart, pages, refreshMetadata, source } = loadRequest
            try {
                let pageMetadata = metadata
                if (pageMetadata == null || refreshMetadata) {
                    const metadataValue = await evaluateJson(`struct('name','${variableExpression}','class',class(${variableExpression}),'size',size(${variableExpression}))`)
                    if (!isVariableMetadata(metadataValue)) throw new Error('MATLAB returned invalid variable metadata')
                    pageMetadata = metadataValue
                }
                if (thisRequestId !== requestId) return
                if (pageMetadata == null) throw new Error('Variable metadata is unavailable')
                if (!DIRECT_MDA_CLASSES.has(pageMetadata.class) && !JSON_VIEW_CLASSES.has(pageMetadata.class)) {
                    throw new Error(`Class '${pageMetadata.class}' is not supported by the Variable Editor`)
                }
                metadata = pageMetadata
                const [rowCount = 1, columnCount = 1, ...pageSizes] = pageMetadata.size
                const sliceCount = pageSizes.reduce((total, size) => total * size, 1)
                const elementCount = rowCount * columnCount * sliceCount
                const canFingerprintSlices = pageSizes.length > 0 && sliceCount > 0 && rowCount * columnCount > 0 &&
                    sliceCount <= DIMENSION_FINGERPRINT_PAGE_LIMIT &&
                    elementCount <= DIMENSION_FINGERPRINT_ELEMENT_LIMIT &&
                    DIRECT_MDA_CLASSES.has(pageMetadata.class)
                if (canFingerprintSlices && (refreshMetadata || sliceSignatures.length !== sliceCount)) {
                    const sliceLength = rowCount * columnCount
                    const fingerprintExpression = `feval(@(x,w)struct('sumReal',sum(real(x),1,'omitnan'),'sumImag',sum(imag(x),1,'omitnan'),'sumAbs',sum(abs(x),1,'omitnan'),'weightedReal',sum(w.*real(x),1,'omitnan'),'weightedImag',sum(w.*imag(x),1,'omitnan'),'nanCount',sum(isnan(x),1)),reshape(double(${variableExpression}),[],${sliceCount}),(1:${sliceLength})')`
                    sliceSignatures = sliceFingerprintSignatures(
                        await evaluateJson(fingerprintExpression) as Record<string, unknown>,
                        sliceCount
                    )
                } else if (!canFingerprintSlices) {
                    sliceSignatures = []
                }
                if (thisRequestId !== requestId) return
                const safeRow = Math.max(1, Math.min(rowStart, rowCount))
                const safeColumn = Math.max(1, Math.min(columnStart, columnCount))
                const rowEnd = Math.min(rowCount, safeRow + VARIABLE_PAGE_ROWS - 1)
                const columnEnd = Math.min(columnCount, safeColumn + VARIABLE_PAGE_COLUMNS - 1)
                const pageIndices = pageSizes.map((size, index) => Math.max(1, Math.min(pages[index] ?? 1, size)))
                currentPage = { rowStart: safeRow, columnStart: safeColumn, pages: pageIndices }
                const suffix = pageIndices.map(index => `,${index}`).join('')
                let sliceExpression = `${variableExpression}(${safeRow}:${rowEnd},${safeColumn}:${columnEnd}${suffix})`
                let columnNames: unknown
                let rowNames: unknown
                let values: unknown
                if (pageMetadata.class === 'table' || pageMetadata.class === 'timetable') {
                    const tableSlice = sliceExpression
                    const columnNameExpression = `${variableExpression}.Properties.VariableNames(${safeColumn}:${columnEnd})`
                    const rowNameExpression = pageMetadata.class === 'timetable'
                        ? `cellstr(string(${variableExpression}.Properties.RowTimes(${safeRow}:${rowEnd})))`
                        : `subsref([${variableExpression}.Properties.RowNames;cellstr(string((1:height(${variableExpression}))'))],substruct('()',{${safeRow}:${rowEnd}}))`
                    sliceExpression = `struct('columnNames',{${columnNameExpression}},'rowNames',{${rowNameExpression}},'rows',{table2struct(${tableSlice})})`
                    const tablePage = tablePayloadToGrid(await evaluateJson(sliceExpression) as Record<string, unknown>)
                    columnNames = tablePage.columnNames
                    rowNames = tablePage.rowNames
                    values = boundValueForWebview(tablePage.values)
                } else {
                    values = DIRECT_MDA_CLASSES.has(pageMetadata.class)
                        ? await evaluateMda(sliceExpression)
                        : boundValueForWebview(await evaluateJson(sliceExpression))
                }
                if (thisRequestId !== requestId) return
                void panel.webview.postMessage({
                    type: 'data',
                    metadata: pageMetadata,
                    values,
                    rowStart: safeRow,
                    columnStart: safeColumn,
                    rowEnd,
                    columnEnd,
                    pageIndices,
                    columnNames,
                    rowNames,
                    sliceSignatures,
                    source,
                    updatedAt: Date.now()
                })
            } catch (error) {
                if (thisRequestId !== requestId) return
                const message = error instanceof Error ? error.message : this.extractErrorMessage(error)
                void panel.webview.postMessage({ type: 'error', message, source })
            }
        }

        const drainLoadQueue = async (): Promise<void> => {
            if (loadRunning) return
            loadRunning = true
            try {
                while (pendingLoad != null) {
                    const nextLoad = pendingLoad
                    pendingLoad = undefined
                    await loadPage(nextLoad)
                }
            } finally {
                loadRunning = false
            }
        }

        const scheduleLoadPage = (
            rowStart = 1,
            columnStart = 1,
            pages: number[] = [],
            refreshMetadata = false,
            source: LoadSource = 'manual'
        ): void => {
            pendingLoad = {
                id: ++requestId,
                rowStart,
                columnStart,
                pages: [...pages],
                refreshMetadata,
                source
            }
            void drainLoadQueue()
        }

        const copySelection = async (selection: VariableSelection | undefined, pages: number[] = []): Promise<void> => {
            if (selection == null) return
            try {
                let copyMetadata = metadata
                if (copyMetadata == null) {
                    const metadataValue = await evaluateJson(`struct('name','${variableExpression}','class',class(${variableExpression}),'size',size(${variableExpression}))`)
                    if (!isVariableMetadata(metadataValue)) throw new Error('MATLAB returned invalid variable metadata')
                    copyMetadata = metadataValue
                    metadata = copyMetadata
                }
                if (!DIRECT_MDA_CLASSES.has(copyMetadata.class) && !JSON_VIEW_CLASSES.has(copyMetadata.class)) {
                    throw new Error(`Class '${copyMetadata.class}' is not supported by the Variable Editor`)
                }
                const [rowCount = 1, columnCount = 1, ...pageSizes] = copyMetadata.size
                const rowStart = Math.max(1, Math.min(selection.rowStart, selection.rowEnd, rowCount))
                const rowEnd = Math.max(rowStart, Math.min(Math.max(selection.rowStart, selection.rowEnd), rowCount))
                const columnStart = Math.max(1, Math.min(selection.columnStart, selection.columnEnd, columnCount))
                const columnEnd = Math.max(columnStart, Math.min(Math.max(selection.columnStart, selection.columnEnd), columnCount))
                const cellCount = (rowEnd - rowStart + 1) * (columnEnd - columnStart + 1)
                if (cellCount > VARIABLE_COPY_CELL_LIMIT) {
                    throw new Error(`Selection contains ${cellCount.toLocaleString()} cells; the copy limit is ${VARIABLE_COPY_CELL_LIMIT.toLocaleString()}.`)
                }
                const pageIndices = pageSizes.map((size, index) => Math.max(1, Math.min(pages[index] ?? 1, size)))
                const suffix = pageIndices.map(index => `,${index}`).join('')
                let sliceExpression = `${variableExpression}(${rowStart}:${rowEnd},${columnStart}:${columnEnd}${suffix})`
                let values: unknown
                if (copyMetadata.class === 'table' || copyMetadata.class === 'timetable') {
                    const columnNameExpression = `${variableExpression}.Properties.VariableNames(${columnStart}:${columnEnd})`
                    sliceExpression = `struct('columnNames',{${columnNameExpression}},'rows',{table2struct(${sliceExpression})})`
                    values = tablePayloadToGrid(await evaluateJson(sliceExpression) as Record<string, unknown>).values
                } else {
                    values = DIRECT_MDA_CLASSES.has(copyMetadata.class)
                        ? await evaluateMda(sliceExpression)
                        : await evaluateJson(sliceExpression)
                }
                const clipboardText = valuesToTsv(values, rowEnd - rowStart + 1, columnEnd - columnStart + 1)
                if (Buffer.byteLength(clipboardText, 'utf8') > MAX_CLIPBOARD_BYTES) {
                    throw new Error(`Copied data exceeds the ${Math.round(MAX_CLIPBOARD_BYTES / 1_000_000)} MB clipboard limit`)
                }
                await vscode.env.clipboard.writeText(clipboardText)
                void panel.webview.postMessage({ type: 'copyComplete', message: `Copied ${cellCount.toLocaleString()} cells` })
            } catch (error) {
                const message = error instanceof Error ? error.message : this.extractErrorMessage(error)
                void panel.webview.postMessage({ type: 'copyError', message })
            }
        }

        const refresh = (): void => {
            if (!autoRefreshEnabled) return
            if (!panel.visible) {
                refreshPendingWhileHidden = true
                return
            }
            refreshPendingWhileHidden = false
            scheduleLoadPage(currentPage.rowStart, currentPage.columnStart, currentPage.pages, true, 'auto')
        }
        this.variableEditorRefreshes.add(refresh)
        panel.onDidDispose(() => {
            this.variableEditorRefreshes.delete(refresh)
            this.variableEditorPanels.delete(panel)
            if (this.preferredVariableEditorPanel === panel) {
                this.preferredVariableEditorPanel = this.variableEditorPanels.values().next().value
            }
        })
        panel.onDidChangeViewState(({ webviewPanel }) => {
            if (webviewPanel.active) this.preferredVariableEditorPanel = webviewPanel
            if (webviewPanel.visible && refreshPendingWhileHidden) refresh()
        })

        panel.webview.onDidReceiveMessage((rawMessage: unknown) => {
            if (!isVariableEditorWebviewMessage(rawMessage)) {
                void panel.webview.postMessage({ type: 'error', message: 'Rejected an invalid Variable Editor request', source: 'manual' })
                return
            }
            const message: VariableEditorWebviewMessage = rawMessage
            if (message.type === 'page') {
                const expectedPages = metadata?.size.slice(2).length
                if (expectedPages != null && message.pages?.length !== expectedPages) {
                    void panel.webview.postMessage({ type: 'error', message: 'Rejected an invalid dimension selection', source: 'manual' })
                    return
                }
                scheduleLoadPage(message.rowStart, message.columnStart, message.pages, false, message.source ?? 'manual')
            }
            if (message.type === 'ready') {
                autoRefreshEnabled = message.autoRefresh ?? true
                scheduleLoadPage(currentPage.rowStart, currentPage.columnStart, currentPage.pages, false, 'initial')
            }
            if (message.type === 'autoRefresh') {
                autoRefreshEnabled = message.enabled ?? true
                if (autoRefreshEnabled) refresh()
            }
            if (message.type === 'copySelection') void copySelection(message.selection, message.pages)
            if (message.type === 'openNested' && message.expression != null) void this.openVariableEditor(message.expression)
        })
        panel.webview.html = getVariableEditorHtml(variableExpression, crypto.randomBytes(18).toString('base64'))
    }

    // Send cached columns, data, and state to the webview when it signals readiness
    private handleWebviewReady (): void {
        // Always send columns so the header is visible immediately
        const columnsToSend = this.cachedColumns ?? DEFAULT_COLUMNS
        this.postToWebview({ type: 'setColumns', columns: columnsToSend })

        if (this.cachedRows != null) {
            this.sendDataToWebview()
        }
        if (this.savedState != null) {
            this.postToWebview({ type: 'setState', state: this.savedState })
        }

        // If no cached data exists, request fresh data from the server
        if (this.cachedRows == null) {
            this.notifier.sendNotification(Notification.WSBClientMessage, { type: 'GetSize' })
        }
    }

    // Assign a new value to a MATLAB variable in the active workspace
    private async handleEditValue (variable: string, newValue: string): Promise<void> {
        try {
            await this.mvm.getReadyPromise()
        } catch {
            this.postToWebview({ type: 'operationError', operation: 'editValue', variable, message: 'MATLAB is not ready' })
            return
        }

        try {
            const response = await this.evalInWorkspace(`${variable} = ${newValue};`)
            if ('error' in response) {
                const message = this.extractErrorMessage(response.error)
                this.postToWebview({ type: 'operationError', operation: 'editValue', variable, message })
                this.showMatlabError('editValue', message)
            }
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e)
            this.postToWebview({ type: 'operationError', operation: 'editValue', variable, message })
            this.showMatlabError('editValue', message)
        }
    }

    // Rename a variable by assigning to the new name and clearing the old one in the active workspace
    private async handleRenameVariable (oldName: string, newName: string): Promise<void> {
        if (!WorkspaceBrowserProvider.isValidMatlabIdentifier(newName)) {
            const message = `'${newName}' is not a valid MATLAB variable name. ` +
                'Names must begin with a letter, contain only letters/digits/underscores, and not exceed 2048 characters.'
            this.postToWebview({ type: 'operationError', operation: 'rename', variable: oldName, message })
            this.showMatlabError('rename', message)
            return
        }

        // Client-side duplicate check against cached workspace state
        if (this.cachedRows?.some((row: WorkspaceVariable) => row.name === newName) === true) {
            const message = `A variable named "${newName}" already exists`
            this.postToWebview({ type: 'operationError', operation: 'rename', variable: oldName, message })
            this.showMatlabError('rename', message)
            return
        }

        try {
            await this.mvm.getReadyPromise()
        } catch {
            this.postToWebview({ type: 'operationError', operation: 'rename', variable: oldName, message: 'MATLAB is not ready' })
            return
        }

        try {
            const response = await this.evalInWorkspace(`${newName} = ${oldName}; clear('${oldName}');`)
            if ('error' in response) {
                const message = this.extractErrorMessage(response.error)
                this.postToWebview({ type: 'operationError', operation: 'rename', variable: oldName, message })
                this.showMatlabError('rename', message)
            }
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e)
            this.postToWebview({ type: 'operationError', operation: 'rename', variable: oldName, message })
            this.showMatlabError('rename', message)
        }
    }

    // Delete a variable from the active workspace after user confirms via dialog
    private async handleDeleteVariable (variable: string): Promise<void> {
        const confirmation = await vscode.window.showWarningMessage(
            `Delete variable "${variable}" from the workspace?`,
            { modal: true },
            'Delete'
        )
        if (confirmation !== 'Delete') return

        try {
            await this.mvm.getReadyPromise()
        } catch {
            this.postToWebview({ type: 'operationError', operation: 'delete', variable, message: 'MATLAB is not ready' })
            return
        }

        try {
            const response = await this.evalInWorkspace(`clear('${variable}');`)
            if ('error' in response) {
                const message = this.extractErrorMessage(response.error)
                this.postToWebview({ type: 'operationError', operation: 'delete', variable, message })
                this.showMatlabError('delete', message)
            }
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e)
            this.postToWebview({ type: 'operationError', operation: 'delete', variable, message })
            this.showMatlabError('delete', message)
        }
    }

    // Persist UI state (column widths, sort preferences) to workspace storage.
    // Re-sends sorted/capped data when sort preferences change.
    private handleStateChanged (state: SavedState): void {
        const sortChanged = state.sortColumn !== this.savedState?.sortColumn ||
            state.sortDirection !== this.savedState?.sortDirection
        this.savedState = state
        void this.extensionContext.workspaceState.update(WSB_STATE_KEY, state)

        if (sortChanged) {
            this.sendDataToWebview()
        }
    }

    // Executes a MATLAB command in the workspace the browser is currently displaying.
    // During debug, uses feval('eval', ...) to execute in the paused frame's workspace
    // while still receiving error responses through the feval channel.
    // Outside debug, uses evalin('base', ...) to target the base workspace.
    private async evalInWorkspace (command: string): Promise<{ error: unknown } | { result: unknown[] }> {
        if (this.mvm.isDebugging()) {
            return await this.mvm.feval('eval', 0, [command], false)
        }
        return await this.mvm.feval('evalin', 0, ['base', command], false)
    }

    // ── Data Request Throttling ──────────────────────────────────────

    // Coalesces rapid DataChanged events to avoid flooding the server with GetData requests
    private scheduleDataRequest (): void {
        // Empty workspace: bypass throttle and clear immediately
        if (this.numRows === 0) {
            this.cancelPendingDataRequest()
            this.cachedRows = []
            this.postToWebview({ type: 'setData', rows: [] })
            this.postToWebview({ type: 'setTruncationInfo', displayedCount: 0, totalCount: 0 })
            return
        }

        if (this.dataRequestPending) return
        this.dataRequestPending = true
        this.dataRequestTimer = setTimeout(() => {
            this.dataRequestPending = false
            this.dataRequestTimer = undefined
            this.requestData()
        }, DATA_THROTTLE_MS)
    }

    // Refresh open variable editors after workspace mutations, capped at roughly
    // three refreshes per second even when MATLAB emits rapid DataChanged events.
    private scheduleVariableEditorRefresh (): void {
        if (this.variableEditorRefreshes.size === 0 || this.variableEditorRefreshTimer != null) return
        this.variableEditorRefreshTimer = setTimeout(() => {
            this.variableEditorRefreshTimer = undefined
            for (const refresh of this.variableEditorRefreshes) refresh()
        }, DATA_THROTTLE_MS)
    }

    private cancelPendingDataRequest (): void {
        if (this.dataRequestTimer != null) {
            clearTimeout(this.dataRequestTimer)
            this.dataRequestTimer = undefined
        }
        this.dataRequestPending = false
    }

    private requestData (): void {
        this.notifier.sendNotification(Notification.WSBClientMessage, {
            type: 'GetData',
            startRow: 1,
            endRow: this.numRows + 1
        })
    }

    // Sorts the full cached dataset, caps to maxVariables, and sends to the webview
    private sendDataToWebview (): void {
        if (this.cachedRows == null) return

        const sorted = this.sortRows(this.cachedRows)
        const maxVariables = this.getMaxVariableCount()
        const capped = sorted.length > maxVariables ? sorted.slice(0, maxVariables) : sorted

        this.postToWebview({ type: 'setData', rows: capped })
        this.postToWebview({ type: 'setTruncationInfo', displayedCount: capped.length, totalCount: this.numRows })
    }

    private sortRows (data: WorkspaceVariable[]): WorkspaceVariable[] {
        const column = this.savedState?.sortColumn ?? ''
        const direction = this.savedState?.sortDirection ?? 'asc'
        if (column === '' || data.length === 0) return data

        const numeric = this.getSortMethod() === 'natural'
        const sorted = [...data]
        sorted.sort((a: WorkspaceVariable, b: WorkspaceVariable): number => {
            const aVal = a.fields[column] ?? ''
            const bVal = b.fields[column] ?? ''
            const cmp = aVal.localeCompare(bVal, undefined, { numeric, sensitivity: 'base' })
            return direction === 'asc' ? cmp : -cmp
        })
        return sorted
    }

    // ── Max Variables Warning ────────────────────────────────────────

    private getMaxVariableCount (): number {
        return vscode.workspace.getConfiguration('MATLAB')
            .get<number>('maximumWorkspaceVariables', WSB_DEFAULT_MAX_VARIABLES)
    }

    private getSortMethod (): 'natural' | 'lexicographic' {
        return vscode.workspace.getConfiguration('MATLAB')
            .get<'natural' | 'lexicographic'>('workspaceSortMethod', 'natural')
    }

    // Show an info message when the workspace exceeds the configured variable limit
    private checkMaxVariablesWarning (): void {
        const max = this.getMaxVariableCount()
        if (this.numRows > max && !this.maxVarsMessageShown) {
            this.maxVarsMessageShown = true
            const message = MAX_VARIABLES_MESSAGE_TEMPLATE
                .replace('{currentCount}', this.numRows.toString())
                .replace('{maxVariables}', max.toString())

            void vscode.window.showInformationMessage(message, MAX_VARS_BUTTON_TEXT)
                .then((selection: string | undefined) => {
                    if (selection === MAX_VARS_BUTTON_TEXT) {
                        void vscode.commands.executeCommand('workbench.action.openSettings', MAX_VARS_SETTING_ID)
                    }
                })
        }
    }

    // ── Webview HTML & Messaging ─────────────────────────────────────

    private postToWebview (message: ExtToWebview): void {
        if (this.view != null) {
            void this.view.webview.postMessage(message)
        }
    }

    // MATLAB feval errors arrive as { id, msg, status } objects.
    // Extracts the human-readable msg field for display in toast notifications.
    private extractErrorMessage (error: unknown): string {
        if (typeof error === 'string') return error
        if (error != null && typeof error === 'object' && 'msg' in error) {
            return String((error as { msg: unknown }).msg)
        }
        return String(error)
    }

    // Shows a persistent toast notification so the user knows why an operation failed.
    // The operation prefix provides context since toasts appear globally in VS Code.
    private showMatlabError (operation: string, message: string): void {
        const prefix = operation === 'editValue'
            ? 'Edit failed'
            : operation === 'rename'
                ? 'Rename failed'
                : 'Delete failed'
        void vscode.window.showErrorMessage(`${prefix}: ${message}`)
    }
}
