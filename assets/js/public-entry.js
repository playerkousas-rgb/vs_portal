/* Legacy entry.html compatibility route.
   The former anonymous finance form was removed. Personal submissions must originate
   from an authenticated member session; until that hub workflow is available this
   route returns users to the secure member home instead of accepting unbound data. */
const q = new URLSearchParams(location.search);
const target = new URL('./members.html', location.href);
if (q.get('u')) target.searchParams.set('u', q.get('u'));
if (q.get('be')) target.searchParams.set('be', q.get('be'));
target.hash = '/home';
location.replace(target.toString());
