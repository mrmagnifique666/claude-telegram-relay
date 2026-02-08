import 'dotenv/config';

const key = process.env.MOLTBOOK_API_KEY;
const BASE = 'https://www.moltbook.com/api/v1';

async function api(path) {
  const res = await fetch(BASE + path, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }
  });
  if (res.status !== 200) return null;
  return res.json();
}

async function run() {
  const data = await api('/posts?author=KingstonAI&limit=25');
  const posts = data?.posts || [];
  console.log(`=== Posts de Kingston (${posts.length}) ===\n`);

  for (const p of posts) {
    const sub = typeof p.submolt === 'object' ? p.submolt?.name : p.submolt;
    const date = p.created_at ? new Date(p.created_at).toLocaleString('fr-CA', { timeZone: 'America/Toronto' }) : '';
    console.log(`-- ${p.title}`);
    console.log(`   s/${sub || '?'} | Score: ${p.score || 0} | Comments: ${p.comment_count || 0} | ${date}`);

    if (p.comment_count > 0) {
      const details = await api('/posts/' + p.id);
      if (details) {
        const post = details.post || details.data || details;
        const comments = post.comments || details.comments || [];
        if (comments.length > 0) {
          for (const c of comments) {
            const cBy = typeof c.author === 'object' ? c.author?.name : c.author || '?';
            const indent = c.parent_id ? '      reply ' : '   > ';
            console.log(indent + cBy + ': ' + (c.content || '').slice(0, 250));
          }
        }
      }
    }
    console.log('');
  }
}

run().catch(e => console.error('Error:', e.message));
