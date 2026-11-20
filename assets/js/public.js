/* Legacy constitution.html compatibility route.
   Anonymous constitution rendering was removed: every reader must authenticate in
   the branch member hub before the server returns the published constitution. */
const q = new URLSearchParams(location.search);
const unit = q.get('u') || '';
const target = new URL('./members.html', location.href);
if (unit) target.searchParams.set('u', unit);
target.hash = '/constitution';
location.replace(target.toString());
