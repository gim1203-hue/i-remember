(function() {
  const user = { id: '11111111-1111-4111-8111-111111111111', email: 'camera-test@example.test', user_metadata: {} };
  const state = window.__mock = {
    tables: JSON.parse(sessionStorage.getItem('mock-tables') || '{}'), failUpload: false, failInsert: false,
    failDelete: false, uploadDelay: 0, uploads: [], pin: null, authListener: null
  };
  const persist = () => sessionStorage.setItem('mock-tables', JSON.stringify(state.tables));
  async function files(operation, path, blob) {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('mock-cloud', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('files');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('files', operation === 'get' ? 'readonly' : 'readwrite');
        const store = tx.objectStore('files');
        const request = operation === 'get' ? store.get(path) : operation === 'put' ? store.put(blob, path) : store.delete(path);
        let value;
        request.onsuccess = () => { value = request.result; };
        tx.oncomplete = () => resolve(value); tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
  }
  function from(table) {
    let operation = 'read', values, single = false, filters = [], orders = [], range;
    const query = {
      select() { return query; },
      insert(row) { operation = 'insert'; values = row; return query; },
      upsert(row) { operation = 'upsert'; values = row; return query; },
      update(row) { operation = 'update'; values = row; return query; },
      delete() { operation = 'delete'; return query; },
      eq(key, value) { filters.push(row => row[key] === value); return query; },
      match(fields) { Object.entries(fields).forEach(([key, value]) => query.eq(key, value)); return query; },
      gte(key, value) { filters.push(row => row[key] >= value); return query; },
      lte(key, value) { filters.push(row => row[key] <= value); return query; },
      order(key, options) { orders.push([key, options]); return query; },
      range(start, end) { range = [start, end]; return query; },
      limit(count) { range = [0, count - 1]; return query; },
      single() { single = true; return query; }, maybeSingle() { single = true; return query; },
      then(resolve, reject) {
        return Promise.resolve().then(() => {
          const rows = state.tables[table] || (state.tables[table] = []);
          let result = rows.filter(row => filters.every(filter => filter(row)));
          if (operation === 'insert' || operation === 'upsert') {
            if (state.failInsert && table === 'media') return { error: { message: 'Database unavailable' }, data: null };
            let row = operation === 'upsert' && rows.find(row => table === 'entries' ? row.entry_date === values.entry_date : row.id === values.id);
            if (operation === 'insert' && rows.some(row => row.id === values.id && values.id)) return { error: { code: '23505', message: 'Duplicate' }, data: null };
            if (row) Object.assign(row, values);
            else { row = { id: crypto.randomUUID(), position: 0, ...values }; rows.push(row); }
            result = [row]; persist();
          } else if (operation === 'update') { result.forEach(row => Object.assign(row, values)); persist(); }
          else if (operation === 'delete') {
            if (state.failDelete) return { error: { message: 'Delete unavailable' }, data: null };
            state.tables[table] = rows.filter(row => !result.includes(row)); persist();
          }
          result = [...result].sort((a, b) => {
            for (const [key, options] of orders) {
              const difference = String(a[key] || '').localeCompare(String(b[key] || ''));
              if (difference) return options && options.ascending === false ? -difference : difference;
            }
            return 0;
          });
          if (range) result = result.slice(range[0], range[1] + 1);
          return { data: single ? result[0] || null : result, error: null };
        }).then(resolve, reject);
      }
    };
    return query;
  }
  const storage = {
    async upload(path, blob) {
      if (state.uploadDelay) await new Promise(resolve => setTimeout(resolve, state.uploadDelay));
      if (state.failUpload) return { error: { message: 'Offline' } };
      if (await files('get', path)) return { error: { statusCode: '409', message: 'Already exists' } };
      await files('put', path, blob); state.uploads.push({ path, bytes: blob.size, type: blob.type });
      return { data: { path }, error: null };
    },
    async createSignedUrls(paths) {
      const data = [];
      for (const path of paths) { const blob = await files('get', path); data.push({ path, signedUrl: blob ? URL.createObjectURL(blob) : null }); }
      return { data, error: null };
    },
    async remove(paths) {
      if (state.failDelete) return { error: { message: 'Delete unavailable' } };
      for (const path of paths) await files('delete', path);
      return { data: [], error: null };
    }
  };
  const client = {
    from, storage: { from: () => storage },
    auth: {
      onAuthStateChange(callback) { state.authListener = callback; return {}; },
      async getSession() { return { data: { session: { user } } }; },
      async signOut() { state.authListener('SIGNED_OUT', null); return { error: null }; },
      async signInWithOAuth() { return { error: null }; }
    },
    async rpc(name, parameters) {
      if (name === 'has_app_pin') return { data: state.pin !== null, error: null };
      if (name === 'set_app_pin') { state.pin = parameters.pin_value; return { data: null, error: null }; }
      if (name === 'verify_app_pin') return { data: state.pin === parameters.pin_value, error: null };
      return { data: false, error: null };
    }
  };
  window.supabase = { createClient: () => client };
})();
