require('@next/env').loadEnvConfig('/app');
(async () => {
 if (process.env.TOUR_EMAIL_MODE !== 'send' || !process.env.TOUR_EMAIL_CRON_SECRET) throw 0;
 const response = await fetch('http://127.0.0.1:3000/api/tour-emails', {
  method:'POST', headers:{Authorization:'Bearer '+process.env.TOUR_EMAIL_CRON_SECRET},
  signal:AbortSignal.timeout(150000)
 });
 if (!response.ok) throw 0;
 const data = await response.json();
 if (data.mode !== 'send') throw 0;
 console.log(new Date().toISOString(), JSON.stringify(data));
})().catch(() => { console.error('Tour email worker unavailable; check protected server logs.'); process.exit(1); });
