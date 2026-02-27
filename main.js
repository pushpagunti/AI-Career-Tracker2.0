const { app, BrowserWindow, ipcMain, Notification } = require('electron');
const path = require('path');
const Datastore = require('nedb');

// Setup nedb database (no native build needed)
const db = new Datastore({ 
  filename: path.join(app.getPath('userData'), 'career-tracker.db'), 
  autoload: true 
});

// Category detection keywords
const LEARNING_KEYWORDS = ['code', 'vscode', 'python', 'tutorial', 'docs', 'stackoverflow', 
                           'github', 'udemy', 'coursera', 'documentation', 'java', 'javascript',
                           'html', 'css', 'react', 'node', 'programming', 'leetcode', 'hackerrank'];

const DISTRACTION_KEYWORDS = ['netflix', 'youtube', 'facebook', 'instagram', 'reddit', 
                               'tiktok', 'gaming', 'twitch', 'spotify', 'twitter', 'reels',
                               'comedy', 'trailer', 'movie', 'series', 'meme', 'snapchat'];

function categorize(title) {
  const t = (title || '').toLowerCase();
  if (LEARNING_KEYWORDS.some(k => t.includes(k))) return 'learning';
  if (DISTRACTION_KEYWORDS.some(k => t.includes(k))) return 'distraction';
  return 'productive';
}

function getToday() {
  return new Date().toISOString().split('T')[0];
}

let mainWindow;
let overlayWindow;
let currentApp = null;
let startTime = null;
let deepWorkMode = false;
let trackingInterval = null;
let activeWin = null;

// Load active-win (ESM module -- requires dynamic import)
async function loadActiveWin() {
  try {
    const mod = await import('active-win');
    activeWin = mod.default;
    console.log('active-win loaded successfully');
  } catch (e) {
    console.error('Failed to load active-win:', e.message);
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    backgroundColor: '#0d0d14',
    show: false
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createOverlayWindow(title) {
  if (overlayWindow) {
    overlayWindow.close();
    overlayWindow = null;
  }

  overlayWindow = new BrowserWindow({
    width: 600,
    height: 400,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    transparent: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  overlayWindow.loadFile('overlay.html');

  overlayWindow.once('ready-to-show', () => {
    overlayWindow.show();
    overlayWindow.webContents.send('overlay-init', { appTitle: title });
  });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

// Save the current session to database
function saveSession(appName, category, duration) {
  if (duration < 2) return;
  const record = {
    app_name: appName,
    category: category,
    duration: duration,
    date: getToday(),
    timestamp: Date.now()
  };
  db.insert(record, (err) => {
    if (!err && mainWindow) {
      mainWindow.webContents.send('session-saved', { 
        app: appName, 
        duration, 
        category 
      });
    }
  });
}

async function startTracking() {
  await loadActiveWin();

  if (!activeWin) {
    console.warn('active-win not available -- tracking disabled');
    return;
  }

  trackingInterval = setInterval(async () => {
    try {
      const win = await activeWin();
      if (!win) return;

      const title = win.title || win.owner?.name || 'Unknown';
      const category = categorize(title);

      // Skip our own app window
      if (title.includes('AI Career Tracker') || title.includes('career-tracker')) return;

      // Deep Work blocking
      if (deepWorkMode && category === 'distraction') {
        // Show overlay instead of just notification
        if (!overlayWindow) {
          createOverlayWindow(title);
        }
        if (mainWindow) {
          mainWindow.webContents.send('blocked', title);
        }
        try {
          new Notification({
            title: 'Focus Locked',
            body: `"${title}" is blocked. Deep Work is ON.`
          }).show();
        } catch (e) {}
        return;
      }

      // Close overlay if distraction window is gone or deep work is off
      if (overlayWindow && category !== 'distraction') {
        overlayWindow.close();
        overlayWindow = null;
      }

      // If app changed, save the previous session
      if (currentApp && currentApp !== title && startTime) {
        const duration = Math.floor((Date.now() - startTime) / 1000);
        saveSession(currentApp, categorize(currentApp), duration);
      }

      // Update current tracking
      if (currentApp !== title) {
        currentApp = title;
        startTime = Date.now();
        if (mainWindow) {
          mainWindow.webContents.send('active-window', { title, category });
        }
      }

    } catch (e) {
      // Silently ignore tracking errors
    }
  }, 2000);
}

// ---- IPC Handlers ----

// Get today's stats grouped by category
ipcMain.handle('get-stats', () => {
  return new Promise((resolve) => {
    const today = getToday();
    db.find({ date: today }, (err, docs) => {
      if (err) return resolve([]);
      const grouped = {};
      docs.forEach(d => {
        grouped[d.category] = (grouped[d.category] || 0) + d.duration;
      });
      const result = Object.entries(grouped).map(([category, total]) => ({ category, total }));
      resolve(result);
    });
  });
});

// Get 7-day trend data
ipcMain.handle('get-7day', () => {
  return new Promise((resolve) => {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const cutoff = sevenDaysAgo.toISOString().split('T')[0];

    db.find({ date: { $gte: cutoff } }, (err, docs) => {
      if (err) return resolve([]);
      const grouped = {};
      docs.forEach(d => {
        const key = `${d.date}__${d.category}`;
        grouped[key] = (grouped[key] || 0) + d.duration;
      });
      const result = Object.entries(grouped).map(([key, total]) => {
        const [date, category] = key.split('__');
        return { date, category, total };
      });
      result.sort((a, b) => a.date.localeCompare(b.date));
      resolve(result);
    });
  });
});

// Get history (last 50 sessions grouped by app+date)
ipcMain.handle('get-history', () => {
  return new Promise((resolve) => {
    db.find({}).sort({ timestamp: -1 }).limit(100).exec((err, docs) => {
      if (err) return resolve([]);
      // Group by app_name + date
      const grouped = {};
      docs.forEach(d => {
        const key = `${d.app_name}__${d.date}`;
        if (!grouped[key]) {
          grouped[key] = { app_name: d.app_name, category: d.category, duration: 0, date: d.date };
        }
        grouped[key].duration += d.duration;
      });
      const result = Object.values(grouped)
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 50);
      resolve(result);
    });
  });
});

// Toggle Deep Work mode
ipcMain.handle('set-deep-work', (_, val) => {
  deepWorkMode = val;
  if (!deepWorkMode && overlayWindow) {
    overlayWindow.close();
    overlayWindow = null;
  }
  return deepWorkMode;
});

// Close the overlay from renderer
ipcMain.handle('close-overlay', () => {
  if (overlayWindow) {
    overlayWindow.close();
    overlayWindow = null;
  }
  return true;
});

// Get career XP (total learning + productive seconds)
ipcMain.handle('get-career-xp', () => {
  return new Promise((resolve) => {
    db.find({ category: { $in: ['learning', 'productive'] } }, (err, docs) => {
      if (err) return resolve(0);
      const total = docs.reduce((sum, d) => sum + d.duration, 0);
      resolve(total);
    });
  });
});

// ---- App Lifecycle ----

app.whenReady().then(() => {
  createMainWindow();
  startTracking();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // Save current session before quitting
  if (currentApp && startTime) {
    const duration = Math.floor((Date.now() - startTime) / 1000);
    saveSession(currentApp, categorize(currentApp), duration);
  }
  if (trackingInterval) clearInterval(trackingInterval);
  if (process.platform !== 'darwin') app.quit();
});