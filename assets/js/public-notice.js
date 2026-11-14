/* Legacy notice.html compatibility route.
   Anonymous notice viewing and signup were removed. The member hub keeps the desired
   notice route across login and receives only the authenticated server projection. */
const q = new URLSearchParams(location.search);
const unit = q.get('u') || '';
const notice = q.get('n') || '';
const backend = q.get('be') || '';
const target = new URL('./members.html', location.href);
if (unit) target.searchParams.set('u', unit);
if (backend) target.searchParams.set('be', backend);
target.hash = notice ? `/notice/${encodeURIComponent(notice)}` : '/home';
location.replace(target.toString());
