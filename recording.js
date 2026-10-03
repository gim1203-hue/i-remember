(function(root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LongRecording = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
  "use strict";

  var MAX_SECONDS = 12 * 60 * 60;
  var PART_SECONDS = 60;
  var PART_BYTES = 5 * 1024 * 1024;

  function formatDuration(seconds) {
    seconds = Math.max(0, Math.floor(seconds));
    var h = Math.floor(seconds / 3600), m = Math.floor(seconds / 60) % 60, s = seconds % 60;
    var pad = function(n) { return String(n).padStart(2, "0"); };
    return h ? h + ":" + pad(m) + ":" + pad(s) : m + ":" + pad(s);
  }

  function partPath(userId, date, kind, sessionId, part) {
    return userId + "/" + date + "/" + kind + "-session-" + sessionId +
      "-part-" + String(part.index).padStart(6, "0") + "-start-" + part.startMs +
      "-end-" + part.endMs + (part.type.indexOf("mp4") >= 0 ? ".mp4" : ".webm");
  }

  function parsePartPath(path) {
    var match = /\/(video|voice)-session-([a-zA-Z0-9-]+)-part-(\d+)-start-(\d+)-end-(\d+)\.(mp4|webm)$/.exec(path || "");
    return match ? { kind: match[1], sessionId: match[2], index: +match[3], startMs: +match[4], endMs: +match[5] } : null;
  }

  function groupParts(items) {
    var groups = [], byId = {};
    items.forEach(function(item) {
      var part = parsePartPath(item.path);
      if (!part) { groups.push({ parts: [item], duration: item.duration || "", sessionId: null }); return; }
      var group = byId[part.sessionId];
      if (!group) {
        group = byId[part.sessionId] = { sessionId: part.sessionId, parts: [], endMs: 0, missing: false };
        groups.push(group);
      }
      group.parts.push(item);
      group.endMs = Math.max(group.endMs, part.endMs);
    });
    groups.forEach(function(group) {
      if (!group.sessionId) return;
      group.parts.sort(function(a, b) { return parsePartPath(a.path).index - parsePartPath(b.path).index; });
      group.parts.forEach(function(item, index) { if (parsePartPath(item.path).index !== index) group.missing = true; });
      group.duration = formatDuration(Math.ceil(group.endMs / 1000));
    });
    return groups;
  }

  // Keep one stream alive. Start the next encoder before finalizing the old
  // encoder; each finalized file includes its own container header/trailer.
  // Timeslice blobs alone are not guaranteed to be independently playable.
  function RecorderSession(options) {
    this.options = options;
    this.now = options.now || function() { return performance.now(); };
    this.Recorder = options.Recorder || MediaRecorder;
    this.setTimer = options.setInterval || function(callback, interval) { return setInterval(callback, interval); };
    this.clearTimer = options.clearInterval || function(timer) { clearInterval(timer); };
    this.active = false;
    this.stopping = false;
    this.segments = new Set();
    this.pendingWrites = 0;
    this.index = 0;
    this.reason = "user";
  }

  RecorderSession.prototype.start = function() {
    this.startedAt = this.now();
    this.active = true;
    try { this.current = this.startPart(); }
    catch (error) { this.active = false; this.releaseStream(); throw error; }
    var self = this;
    this.options.stream.getTracks().forEach(function(track) {
      track.addEventListener("ended", function() { self.stop("device"); });
    });
    this.timer = this.setTimer(function() { self.tick(); }, 250);
  };

  RecorderSession.prototype.startPart = function() {
    var self = this;
    var recorder = new this.Recorder(this.options.stream, this.options.recorderOptions || {});
    var segment = { recorder: recorder, chunks: [], bytes: 0, index: this.index++, startMs: Math.round(this.now() - this.startedAt), endMs: null };
    recorder.ondataavailable = function(event) {
      if (!event.data || !event.data.size) return;
      segment.chunks.push(event.data);
      segment.bytes += event.data.size;
      if (segment === self.current && !self.stopping && segment.bytes >= (self.options.partBytes || PART_BYTES)) self.rotate();
    };
    recorder.onerror = function(event) {
      self.reportError(event.error || new Error("Recording failed"));
      self.stop("error");
    };
    recorder.onstop = function() {
      if (!self.stopping && segment === self.current) self.stop("device");
      self.segments.delete(segment);
      if (segment.endMs === null) segment.endMs = Math.round(self.now() - self.startedAt);
      if (segment.bytes) {
        var type = recorder.mimeType || self.options.mimeType || "audio/webm";
        var blob = new Blob(segment.chunks, { type: type });
        segment.chunks = [];
        self.pendingWrites++;
        Promise.resolve().then(function() {
          return self.options.onPart(blob, { index: segment.index, startMs: segment.startMs, endMs: segment.endMs, type: type });
        }).catch(function(error) {
          self.reportError(error, blob, segment);
          self.stop("storage");
        }).finally(function() { self.pendingWrites--; self.finishIfReady(); });
        if (self.pendingWrites > 2) self.stop("storage");
      }
      self.finishIfReady();
    };
    recorder.start(1000);
    this.segments.add(segment);
    return segment;
  };

  RecorderSession.prototype.reportError = function(error, blob, part) {
    if (this.options.onError) this.options.onError(error, blob, part);
  };

  RecorderSession.prototype.rotate = function() {
    if (this.stopping || !this.active) return;
    var old = this.current;
    try { this.current = this.startPart(); }
    catch (error) { this.reportError(error); this.stop("error"); return; }
    old.endMs = this.current.startMs;
    if (old.recorder.state !== "inactive") old.recorder.stop();
  };

  RecorderSession.prototype.tick = function() {
    if (this.stopping) return;
    var elapsedMs = this.now() - this.startedAt;
    if (this.options.onTick) this.options.onTick(Math.floor(elapsedMs / 1000));
    if (elapsedMs >= (this.options.maxSeconds || MAX_SECONDS) * 1000) { this.stop("time"); return; }
    if (elapsedMs - this.current.startMs >= (this.options.partSeconds || PART_SECONDS) * 1000) this.rotate();
  };

  RecorderSession.prototype.stop = function(reason) {
    if (!this.active || this.stopping) return;
    this.stopping = true;
    this.reason = reason || "user";
    this.clearTimer(this.timer);
    var self = this;
    this.segments.forEach(function(segment) {
      if (segment.endMs === null) segment.endMs = Math.round(self.now() - self.startedAt);
      if (segment.recorder.state !== "inactive") segment.recorder.stop();
    });
    this.releaseStream();
    if (this.options.onStopping) this.options.onStopping();
    this.finishIfReady();
  };

  RecorderSession.prototype.releaseStream = function() {
    this.options.stream.getTracks().forEach(function(track) { track.stop(); });
  };

  RecorderSession.prototype.finishIfReady = function() {
    if (!this.stopping || this.segments.size || this.pendingWrites || !this.active) return;
    this.active = false;
    if (this.options.onFinish) this.options.onFinish(this.reason);
  };

  function createIndexedDBStore(indexedDB) {
    var opening;
    function open() {
      if (!opening) opening = new Promise(function(resolve, reject) {
        var request = indexedDB.open("iremember-recording-parts", 1);
        request.onupgradeneeded = function() {
          request.result.createObjectStore("parts", { keyPath: "id" }).createIndex("userId", "userId");
        };
        request.onsuccess = function() { resolve(request.result); };
        request.onerror = function() { opening = null; reject(request.error); };
      });
      return opening;
    }
    function write(operation) {
      return open().then(function(db) {
        return new Promise(function(resolve, reject) {
          var transaction = db.transaction("parts", "readwrite");
          operation(transaction.objectStore("parts"));
          transaction.oncomplete = function() { resolve(); };
          transaction.onabort = transaction.onerror = function() { reject(transaction.error || new Error("Local recording storage failed")); };
        });
      });
    }
    return {
      ready: open,
      put: function(part) { return write(function(store) { store.put(part); }); },
      remove: function(id) { return write(function(store) { store.delete(id); }); },
      next: function(userId) {
        return open().then(function(db) {
          return new Promise(function(resolve, reject) {
            var request = db.transaction("parts").objectStore("parts").index("userId").openCursor(userId);
            request.onsuccess = function() { resolve(request.result ? request.result.value : null); };
            request.onerror = function() { reject(request.error); };
          });
        });
      },
      count: function(userId) {
        return open().then(function(db) {
          return new Promise(function(resolve, reject) {
            var request = db.transaction("parts").objectStore("parts").index("userId").count(userId);
            request.onsuccess = function() { resolve(request.result); };
            request.onerror = function() { reject(request.error); };
          });
        });
      }
    };
  }

  function DurableQueue(options) {
    this.options = options;
    this.running = null;
  }
  DurableQueue.prototype.enqueue = async function(part) {
    await this.options.store.put(part);
    if (this.options.onChange) this.options.onChange();
    this.flush(); // Capture waits for local persistence, never for the network.
  };
  DurableQueue.prototype.flush = function() {
    if (this.running) return this.running;
    var self = this;
    this.running = Promise.resolve().then(async function() {
      var userId = self.options.getUserId();
      if (!userId) return;
      while (self.options.getUserId() === userId) {
        var part = await self.options.store.next(userId);
        if (!part) break;
        if (self.options.getUserId() !== userId) break;
        var item = await self.options.upload(part);
        await self.options.store.remove(part.id);
        if (self.options.onUploaded) self.options.onUploaded(part, item);
      }
    }).catch(function(error) {
      if (self.options.onError) self.options.onError(error);
    }).finally(function() {
      self.running = null;
      if (self.options.onChange) self.options.onChange();
    });
    return this.running;
  };

  async function capturePhoto(options) {
    var doc = options.document || document;
    var stream = await options.getUserMedia({ video: { facingMode: options.facingMode, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    var video = doc.createElement("video");
    var schedule = options.setTimeout || setTimeout, cancel = options.clearTimeout || clearTimeout;
    try {
      video.muted = true; video.playsInline = true;
      video.setAttribute("muted", ""); video.setAttribute("playsinline", "");
      video.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;";
      doc.body.appendChild(video);
      await new Promise(function(resolve, reject) {
        var timeout = schedule(function() { finish(new Error("Camera did not produce a frame")); }, 15000);
        function finish(error) {
          cancel(timeout); video.onloadeddata = null; video.onerror = null;
          if (error) reject(error); else resolve();
        }
        video.onloadeddata = function() { finish(); };
        video.onerror = function() { finish(new Error("Camera preview failed")); };
        video.srcObject = stream;
        Promise.resolve(video.play()).catch(finish);
        if (video.readyState >= 2) finish();
      });
      await new Promise(function(resolve) { schedule(resolve, 260); });
      if (!video.videoWidth || !video.videoHeight) throw new Error("Camera frame is empty");
      var canvas = doc.createElement("canvas"); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      var context = canvas.getContext("2d");
      if (!context) throw new Error("Camera image could not be processed");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      var blob = await new Promise(function(resolve) { canvas.toBlob(resolve, "image/jpeg", 0.8); });
      if (!blob || !blob.size) throw new Error("Camera image is empty");
      return blob;
    } finally {
      stream.getTracks().forEach(function(track) { track.stop(); });
      video.pause(); video.srcObject = null; video.remove();
    }
  }

  return { MAX_SECONDS: MAX_SECONDS, PART_SECONDS: PART_SECONDS, PART_BYTES: PART_BYTES,
    formatDuration: formatDuration, partPath: partPath, parsePartPath: parsePartPath,
    groupParts: groupParts, RecorderSession: RecorderSession,
    createIndexedDBStore: createIndexedDBStore, DurableQueue: DurableQueue, capturePhoto: capturePhoto };
});
