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

// Which logins each application uses (shown under Configuration). Query
// Testing does not use these - it connects with the Database Configuration.
// JMeter thread 1 uses the first selected user, thread 2 the second, and so on
// (wrapping round if a run has more threads than users).
export const MAX_USERS_PER_GROUP = 2;

// Each group is backed by a users CSV in credentials\ (git-ignored) that lists
// every login for the group: LOGIN_USERNAME and LOGIN_PASSWORD columns, plus
// descriptive columns (Application, Role) JMeter ignores. The file is the
// source of truth - Configuration lists its users, a run reads from it - and
// the app never rewrites it. Number of Users takes that many users from the top.
export const CREDENTIAL_GROUPS = [
  {
    id: 'merchandiser-route',
    label: 'Merchandiser App / Route App',
    applications: ['Merchandiser App', 'Route App'],
    usedFor: 'Merchandiser App and Route App REST and SOAP test runs, and Sales Order Adjustment Web App SOAP test runs',
    usersCsv: 'merchandiser_route_users.csv',
    fileBacked: true,
  },
  {
    id: 'sales-order',
    label: 'Sales Order Adjustment Web App',
    applications: ['Sales Order Adjustment Web App'],
    usedFor: 'Sales Order Adjustment Web App REST test runs',
    usersCsv: 'sales_order_adjustment_users.csv',
    fileBacked: true,
  },
];

// The Sage X3 SOAP gateway only accepts the Merchandiser/Route logins and
// answers 401 to the Sales Order web-app logins, so a SOAP run authenticates
// with this group whichever application it is for. REST runs keep each
// application's own group.
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
