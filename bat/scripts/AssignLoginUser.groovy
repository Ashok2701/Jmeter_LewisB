// PreProcessor at the Thread Group level (REST and SOAP plans), so it runs
// before every sampler but produces no sample of its own. Gives each JMeter
// thread its own login from the users CSV the webapp writes from Configuration
// (LOGIN_USERS_CSV, columns LOGIN_USERNAME,LOGIN_PASSWORD): thread 1 uses row
// 1, thread 2 row 2, and so on, wrapping round when a run has more threads
// than rows. The row is chosen by thread number, not by whichever thread reads
// first, so "user 1" is always the same user.
//
// The chosen login is stored as the thread's JMeter variables LOGIN_USERNAME /
// LOGIN_PASSWORD, which scripts\ApplyAuthHeader.groovy and
// scripts\PrepareRequest.groovy prefer over the process-wide environment
// variables of the same name. Without LOGIN_USERS_CSV (a .bat started by hand,
// or a missing/empty file) nothing is set here and those scripts fall back to
// the environment exactly as before - the single-user flow is unchanged.
//
// Only a row number is ever logged, never a username or password.
import org.apache.jmeter.save.CSVSaveService

// Once per thread.
if (vars.getObject("LOGIN_USER_ASSIGNED") != null) {
    return
}
vars.putObject("LOGIN_USER_ASSIGNED", Boolean.TRUE)

def csvPath = System.getenv("LOGIN_USERS_CSV") ?: props.get("LOGIN_USERS_CSV")
if (!csvPath) {
    return
}

def csvFile = new File(csvPath as String)
if (!csvFile.isFile()) {
    log.warn("AssignLoginUser: users CSV not found - using the single login from the environment")
    return
}

// The same parser the CSV Data Set Config uses with "Allow quoted data", so
// quoted values (a password containing a comma or a quote) read back exactly.
def users = []
csvFile.withReader("UTF-8") { reader ->
    def buffered = new BufferedReader(reader)
    def header = CSVSaveService.csvReadFile(buffered, (char) ',')
    int userCol = header == null ? -1 : header.findIndexOf { it.trim() == "LOGIN_USERNAME" }
    int passCol = header == null ? -1 : header.findIndexOf { it.trim() == "LOGIN_PASSWORD" }
    if (userCol < 0 || passCol < 0) {
        log.warn("AssignLoginUser: users CSV has no LOGIN_USERNAME/LOGIN_PASSWORD header - using the single login from the environment")
        return
    }
    while (buffered.ready()) {
        def row = CSVSaveService.csvReadFile(buffered, (char) ',')
        if (row != null && row.length > Math.max(userCol, passCol) && row[userCol]) {
            users << [username: row[userCol], password: row[passCol]]
        }
    }
}

if (users.isEmpty()) {
    log.warn("AssignLoginUser: users CSV has no users - using the single login from the environment")
    return
}

int index = ctx.getThreadNum() % users.size()
vars.put("LOGIN_USERNAME", users[index].username)
vars.put("LOGIN_PASSWORD", users[index].password)
log.info("AssignLoginUser: thread " + (ctx.getThreadNum() + 1) + " uses login " + (index + 1) + " of " + users.size())
