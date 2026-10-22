import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { join } from 'node:path'
import type { LockReason } from '../shared/types'
import { clearSensitiveClipboard, registerIpc } from './ipc'
import { VaultService } from './vault'

const isDev = !app.isPackaged
const vault = new VaultService()

let mainWindow: BrowserWindow | null = null

app.setName('robust-pwd')

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: '#08080c',
    title: 'robust-pwd',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 18, y: 22 } : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // Aucun contenu distant : tout est local, aucune navigation n'est permise.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) event.preventDefault()
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function installMenu(): void {
  if (process.platform !== 'darwin') return
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]
  if (isDev) template.splice(2, 0, { role: 'viewMenu' })
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

vault.on('locked', (reason: LockReason) => {
  void clearSensitiveClipboard()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('vault:locked', reason)
  }
})

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    installMenu()
    registerIpc(vault)
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    vault.lock('quit')
    void clearSensitiveClipboard()
  })
}
