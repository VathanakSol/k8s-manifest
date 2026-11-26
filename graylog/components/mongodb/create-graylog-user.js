// Runs ONCE, on the first MongoDB start (empty data volume), as root.
// Creates the least-privilege user Graylog and the Data Node connect with:
// it can only read/write and manage indexes in the Graylog database.
// Values come from the graylog-mongodb Secret (see statefulset.yaml env).
const dbName = process.env.GRAYLOG_DB;
const user = process.env.GRAYLOG_DB_USER;
const pwd = process.env.GRAYLOG_DB_PASS;

if (!dbName || !user || !pwd) {
  throw new Error("GRAYLOG_DB, GRAYLOG_DB_USER and GRAYLOG_DB_PASS must be set");
}

db.getSiblingDB(dbName).createUser({
  user: user,
  pwd: pwd,
  roles: [
    { role: "readWrite", db: dbName },
    { role: "dbAdmin", db: dbName },
  ],
});

print(`Created MongoDB user '${user}' on database '${dbName}'`);
