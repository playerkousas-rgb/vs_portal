/* Legacy borrow.html compatibility route.
   Anonymous inventory requests were removed. A request must be tied to an opaque,
   server-verified member session, so this old URL now returns to the secure hub. */
const q = new URLSearchParams(location.search);
const target = new URL('./members.html', location.href);
if (q.get('u')) target.searchParams.set('u', q.get('u'));
if (q.get('be')) target.searchParams.set('be', q.get('be'));
target.hash = '/home';
location.replace(target.toString());
