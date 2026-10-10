let _offset = 0;

export async function syncServerTime(supabase) {
  const t0 = Date.now();
  const { data, error } = await supabase.rpc('get_server_time');
  const t1 = Date.now();
  if (error || !data) return; // fallback to local time on error
  const serverMs = new Date(data).getTime();
  _offset = serverMs + (t1 - t0) / 2 - t1;
}

export function serverNow() {
  return Date.now() + _offset;
}
