// The applications and API Types a test can be run for. Shared by the form
// (app/page.js) and the server (lib/appCsv.js), so the dropdown and what the
// server accepts can never drift apart. Kept free of Node imports so the
// browser bundle can use it.
export const APPLICATIONS = [
  'Merchandiser App',
  'Route App',
  'Sales Order Adjustment Web App',
];

export const API_TYPES = [
  { value: 'REST', label: 'REST APIs' },
  { value: 'SOAP', label: 'SOAP APIs' },
  // "SQL" is the existing backend API Type that runs run_sql_test.bat /
  // sql_test.jmx (JMeter JDBC); the form calls it Query Testing.
  { value: 'SQL', label: 'Query Testing' },
];

// Which API Types each application offers. Query Testing is only set up for
// Sales Order Adjustment Web App.
const APP_API_TYPES = {
  'Merchandiser App': ['REST', 'SOAP'],
  'Route App': ['REST', 'SOAP'],
  'Sales Order Adjustment Web App': ['REST', 'SOAP', 'SQL'],
};

// Which saved logins each application uses (managed under Configuration).
// Merchandiser App and Route App share one group; Sales Order Adjustment Web
// App has its own. Query Testing does not use these - it connects with the
// Database Configuration instead.
//
// A group holds up to MAX_USERS_PER_GROUP logins for multi-user runs: JMeter
// thread 1 uses the first, thread 2 the second, and so on (wrapping round if a
// run has more threads than logins). `usersCsv` is the file (in credentials\)
// the logins are written to for JMeter to read.
export const MAX_USERS_PER_GROUP = 2;

export const CREDENTIAL_GROUPS = [
  {
    id: 'merchandiser-route',
    label: 'Merchandiser App / Route App',
    applications: ['Merchandiser App', 'Route App'],
    usedFor: 'Merchandiser App and Route App REST and SOAP test runs, and Sales Order Adjustment Web App SOAP test runs',
    usersCsv: 'merchandiser_route_users.csv',
  },
  {
    id: 'sales-order',
    label: 'Sales Order Adjustment Web App',
    applications: ['Sales Order Adjustment Web App'],
    usedFor: 'Sales Order Adjustment Web App REST test runs',
    usersCsv: 'sales_order_adjustment_users.csv',
  },
];

// The Sage X3 SOAP gateway only accepts the Merchandiser/Route logins and
// answers 401 to the Sales Order web-app logins (checked against the PILOT
// endpoint), so a SOAP run authenticates with this group whichever application
// it is for. REST runs keep each application's own group.
export const SOAP_CREDENTIAL_GROUP_ID = 'merchandiser-route';

export function credentialGroupFor(applicationName, apiType) {
  if (apiType === 'SOAP') {
    return CREDENTIAL_GROUPS.find((g) => g.id === SOAP_CREDENTIAL_GROUP_ID) ?? null;
  }
  return CREDENTIAL_GROUPS.find((g) => g.applications.includes(applicationName)) ?? null;
}

export function apiTypesFor(applicationName) {
  const allowed = APP_API_TYPES[applicationName] ?? [];
  return API_TYPES.filter((type) => allowed.includes(type.value));
}

export function isApiTypeAllowed(applicationName, apiType) {
  return (APP_API_TYPES[applicationName] ?? []).includes(apiType);
}
