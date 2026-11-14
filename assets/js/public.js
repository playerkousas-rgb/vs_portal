/* Legacy constitution.html compatibility route.
   Anonymous constitution rendering was removed: every reader must authenticate in
   the branch member hub before the server returns the published constitution. */
const q = new URLSearchParams(location.search);
const unit = q.get('u') || '';
const backend = q.get('be') || '';
const target = new URL('./members.html', location.href);
if (unit) target.searchParams.set('u', unit);
if (backend) target.searchParams.set('be', backend);
target.hash = '/constitution';
location.replace(target.toString());
