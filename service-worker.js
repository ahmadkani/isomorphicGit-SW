/* eslint-env serviceworker */
/* globals LightningFS git GitHttp */

importScripts('/js/libs/isomorphicgit.js');
importScripts('/js/libs/LightningFS.js');
importScripts('/js/libs/GitHttp.js');

fs = new LightningFS("fs", { wipe: true, defer: true });
console.log('fs',fs)
let username = '';
let password = '';
let dir = '';
let depth = '';
let remote = 'origin';
let ref = 'main';
let corsProxy = 'https://dnegar-proxy.liara.run';
let cache = new Map();
const http = GitHttp;

const dbName = 'fs';
const storeName = 'fs_files';
const CACHE_NAME = 'cache-v1';
const OFFLINE_URL = '/offline.html';
const URLS_TO_CACHE = [
  '/js/libs/GitHttp.js',
  '/js/libs/isomorphicgit.js',
  '/js/libs/LightningFS.js',
  '/js/libs/MagicPortal.js',
  '/js/libs/require.js',
  '/js/worker.js',
  '/js/script.js',
  OFFLINE_URL
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  console.log('install');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('Opened cache');
      return cache.addAll(URLS_TO_CACHE);
    }).catch((error) => {
      console.error('Failed to cache', error);
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  return self.clients.claim();
});

self.addEventListener('message', (event) => {
  if (event.data.action === 'skipWaiting') {
    self.skipWaiting();
  }
});


const broadcastChannel = new BroadcastChannel('worker-channel');

broadcastChannel.onmessage = async function (event) {
  const message = event.data;
  console.log(message);

  try {
    switch (message.operation) {
      case 'setAuthParams':
        await handleSetAuthParams(message.data);
        break;
      case 'setDir':
        await handleSetDir(message.data);
        break;
      case 'setDepth':
        await handleSetDepth(message.data);
        break;
      case 'setRemote':
        await handleSetRemote(message.data);
        break;
      default:
        await exceptionHandler(message);
        break;
    }
  } catch (error) {
    console.error(`${message.operation} failed`, error);
    throw new Error(error.message);
  }
};


function exceptionHandler(message) {
  console.error('Unhandled message operation:', message.operation);
}

async function handleSetAuthParams(data) {
  if (username !== data.username || password !== data.password) {
    username = data.username || '';
    password = data.password || '';
    broadcastChannel.postMessage({ operation: 'setAuthParams', success: true });
  } else{
    broadcastChannel.postMessage({ operation: 'setAuthParams', success: true });
  }
}

async function handleSetDir(data) {
  if (dir !== data) {
    dir = data;
    broadcastChannel.postMessage({ operation: 'setDir', success: true });
  } else{
    broadcastChannel.postMessage({ operation: 'setDir', success: true });
  }
}

async function handleSetDepth(data) {
  if (depth !== data) {
    depth = data;
    broadcastChannel.postMessage({ operation: 'setDepth', success: true });
  } else{
    broadcastChannel.postMessage({ operation: 'setDepth', success: true });
  }
}

async function handleSetRemote(data) {
  if (remote !== data) {
    remote = data;
    broadcastChannel.postMessage({ operation: 'setRemote', success: true });
  } else{
    broadcastChannel.postMessage({ operation: 'setRemote', success: true });
  }
}


self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  console.log(`Fetching: ${url.pathname}`);

  if (url.pathname === '/git') {
    console.log('event.request',event.request)
    event.respondWith(handleGitRequest(event.request));
  } else {
    console.log('else')
    event.respondWith(fetch(event.request)
    );
  }
});

class Mutex {
  constructor() {
    this.queue = [];
    this.locked = false;
  }

  async lock() {
    return new Promise((resolve) => {
      const execute = () => {
        this.locked = true;
        resolve();
      };

      if (this.locked) {
        this.queue.push(execute);
      } else {
        execute();
      }
    });
  }

  unlock() {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next();
    } else {
      this.locked = false;
    }
  }
}

const mutex = new Mutex();

async function handleGitRequest(request) {
  try {
    const requestData = await request.json();
    const { operation, args } = requestData;

    let response;

    switch (operation) {
      case 'clone':
        response = await clone(args);
        break;
      case 'pull':
        response = await pull(args);
        break;
      case 'push':
        response = await push(args);
        break;
      case 'fetch':
        response = await doFetch(args);
        break;
      default:
        return new Response(JSON.stringify({ error: 'Invalid operation' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error('Git operation failed:', error);

    const statusCode = mapErrorToStatusCode(error.message);
    const errorMessage = getErrorMessage(statusCode);

    return new Response(JSON.stringify({ error: errorMessage }), { status: statusCode, headers: { 'Content-Type': 'application/json' } });
  }
}

async function updateCachedRepository(cacheKey) {
  try {
    // Get the current state of files in the file system
    const currentFiles = await listFiles();

    // Fetch the previously cached files from the cache
    const cachedFiles = await fetchCachedFileList(cacheKey);

    // If no cached files, just cache the current files
    if (!cachedFiles) {
      await cacheFileList(cacheKey, currentFiles);
      return { success: true, message: 'Cache updated with current files' };
    }

    // Compare current files with cached files
    const filesToUpdate = {};
    const filesToDelete = [];

    // Check for added/modified files
    for (const [filePath, fileContent] of Object.entries(currentFiles)) {
      if (!cachedFiles[filePath] || cachedFiles[filePath] !== fileContent) {
        filesToUpdate[filePath] = fileContent;
      }
    }

    // Check for deleted files
    for (const filePath of Object.keys(cachedFiles)) {
      if (!currentFiles[filePath]) {
        filesToDelete.push(filePath);
      }
    }

    // Update the cache with the changes
    const cache = await caches.open(CACHE_NAME);

    // Remove deleted files from cache
    for (const filePath of filesToDelete) {
      await cache.delete(filePath);
    }

    // Update/add modified/new files to cache
    for (const [filePath, fileContent] of Object.entries(filesToUpdate)) {
      const response = new Response(fileContent, {
        headers: { 'Content-Type': 'application/json' },
      });
      await cache.put(filePath, response);
    }

    // Cache the updated file list
    await cacheFileList(cacheKey, currentFiles);

    console.log('Cache updated successfully');
    return { success: true, message: 'Cache updated successfully' };
  } catch (error) {
    console.error('Updating cached repository failed', error);
    throw new Error(error.message);
  } finally {
    // Finally expression
  }
}

//wipes fs
async function wipeFs() {
  try {
    fs = new LightningFS("fs", { wipe: true, defer: true });
  } catch (error) {
      console.error("Error wiping file system:", error);
      throw error; 
  }
}

async function clone(args) {
  await mutex.lock();
  try {
    await wipeFs();
    let cloneResult = await fetchCachedFileList(args.url);
    if (!cloneResult) {
      const result = await git.clone({
        ...args,
        fs,
        http,
        dir,
        remote,
        ref,
        corsProxy,
        depth,
        cache,
        onAuth() {
          return authenticate.fill();
        },
        onAuthFailure() {
          return authenticate.rejected();
        },
      });
      console.log('Clone successful', result);
      console.log('cache',cache)
      const fileList = await listFiles();
      await cacheFileList(args.url, fileList); // Cache the list of files and their contents
      cloneResult = result;
    }
    else{
      await writeFilesToIndexedDB(cloneResult);
      console.log('writeFilesToIndexedDB is called and did the job')
    }

    return { success: true, message: 'The repo has successfully cloned', data: cloneResult };
  } catch (error) {
    console.error('Clone failed', error);
    throw new Error(error.message);
  } finally {
    mutex.unlock();
  }
}

async function cacheFileList(cacheKey, fileList) {
  try {
    const cache = await caches.open(CACHE_NAME);
    const filesWithContent = {};

    for (const [fileName, filePath] of Object.entries(fileList)) {
      const fileContent = await fs.promises.readFile(filePath, 'utf8');
      filesWithContent[filePath] = fileContent;
    }
    console.log('filesWithContent', filesWithContent)

    const response = new Response(JSON.stringify(filesWithContent), {
      headers: { 'Content-Type': 'application/json' }
    });
    await cache.put(cacheKey, response);
    console.log('File list and contents cached successfully', response);
  } catch (error) {
    console.error('Error caching file list and contents:', error);
  }
}

async function listFiles(filePath = dir) {
  try {
    let path = filePath;
    let files = await fs.promises.readdir(filePath);
    let result = {};
    console.log('files',files)

    for (const file of files) {
      console.log('file',file)
      let fullPath = path !== '/' ? `${path}/${file}` : `${path}${file}`;
      const stat = await fs.promises.lstat(fullPath);

      if (stat.isDirectory()) {
        console.log('fullPath',fullPath)
        result = { ...result, ...await listFiles(fullPath) };
      } else {
        console.log('result',result)
        result[fullPath] = fullPath;
      }
    }
    return result;
  } catch (error) {
    console.error('Error listing files:', error);
    throw error;
  }
}

async function fetchCachedFileList(cacheKey) {
  try {
    const cache = await caches.open(CACHE_NAME);
    const cachedResponse = await cache.match(cacheKey);

    if (cachedResponse) {
      const filesWithContent = await cachedResponse.json();
      console.log('Files and contents fetched from cache:', filesWithContent);
      return filesWithContent;
    } else {
      console.log('No cached file list found');
      return null;
    }
  } catch (error) {
    console.error('Error fetching cached file list and contents:', error);
    return null;
  }
}

async function ensureDirectoryExists(fs, dirPath) {
  const parts = dirPath.split('/').filter(part => part);
  let currentPath = '';

  for (const part of parts) {
    currentPath += `/${part}`;
    try {
      await fs.promises.mkdir(currentPath);
      console.log(`Directory created: ${currentPath}`);
    } catch (error) {
      if (error.code !== 'EEXIST') {
        console.error(`Error creating directory: ${currentPath}`, error);
        throw error;
      }
    }
  }
}

async function writeFilesToIndexedDB(filesWithContents) {
  for (const [filePath, fileContent] of Object.entries(filesWithContents)) {
    const directories = filePath.split('/').slice(0, -1).join('/');

    // Create directories if they don't exist
    if (directories) {
      await ensureDirectoryExists(fs, directories);
    }

    // Write file content to the appropriate path
    await fs.promises.writeFile(filePath, fileContent);
  }
  console.log('All files and contents have been written to IndexedDB using LightningFS.');
}

function mapErrorToStatusCode(message) {
  if (message.includes('400')) return 400;
  if (message.includes('401')) return 401;
  if (message.includes('403')) return 403;
  if (message.includes('404')) return 404;
  if (message.includes('409')) return 409;
  if (message.includes('422')) return 422;
  if (message.includes('429')) return 429;
  if (message.includes('500')) return 500;
  if (message.includes('501')) return 501;
  if (message.includes('502')) return 502;
  if (message.includes('503')) return 503;
  if (message.includes('504')) return 504;
  return 500; // Default
}

function getErrorMessage(statusCode) {
  const messages = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    422: 'Unprocessable Entity',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    501: 'Not Implemented',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout'
  };
  return messages[statusCode] || 'Internal Server Error';
}

// Auth object
const authenticate = {
  async fill() {
    return { username, password };
  },
  async rejected() {
    console.log("Authentication rejected");
    return;
  }
};

async function pull(args) {
  await mutex.lock();
  try {
    const result = await git.pull({
      ...args,
      fs,
      http,
      dir,
      corsProxy,
      remote,
      remoteRef: ref,
      cache,
      fastForward: true,
      singleBranch: true,
      onAuth() {
        return authenticate.fill();
      },
      onAuthFailure() {
        return authenticate.rejected();
      },
    });
    return { success: true, message: result };
  } catch (error) {
    throw new Error(error.message);
  } finally {
    mutex.unlock();
  }
}

async function push(args) {
  await mutex.lock();
  try {
    const result = await git.push({
      ...args,
      fs,
      http,
      dir,
      corsProxy,
      remote,
      ref,
      cache,
      force: true,
      onAuth() {
        return authenticate.fill();
      },
      onAuthFailure() {
        return authenticate.rejected();
      },
    });
    return { success: true, message: result };
  } catch (error) {
    throw new Error(error.message);
  } finally {
    mutex.unlock();
  }
}

async function doFetch(args) {
  await mutex.lock();
  try {
    const result = await git.fetch({
      ...args,
      fs,
      http,
      dir,
      corsProxy,
      ref,
      remote,
      depth,
      cache,
      singleBranch: false,
      tags: false,
      onAuth() {
        return authenticate.fill();
      },
      onAuthFailure() {
        return authenticate.rejected();
      },
    });
    return { success: true, message: result };
  } catch (error) {
    throw new Error(error.message);
  } finally {
    mutex.unlock();
  }
}
