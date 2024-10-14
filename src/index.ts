import bodyParser from 'body-parser';
import { Router } from 'express';
import { Chalk } from 'chalk';
import { Client, QueryResult } from 'pg';

interface DatabaseConfig {
    user: string;
    host: string;
    database: string;
    password: string;
    port: number;
}

interface PluginInfo {
    id: string;
    name: string;
    description: string;
}

interface Plugin {
    init: (router: Router) => Promise<void>;
    exit: () => Promise<void>;
    info: PluginInfo;
}

const chalk = new Chalk();
const MODULE_NAME = '[SillyTavern-PostgreSQL]';

// Set up a PostgreSQL Client
const config: DatabaseConfig & { ssl: any } = {
    user: String(process.env.SQL_USER),
    host: String(process.env.SQL_HOST),
    database: String(process.env.SQL_DATABASE),
    password: String(process.env.SQL_PASSWORD),
    port: Number(process.env.SQL_PORT),
    ssl: {
        rejectUnauthorized: false
    }
}

const client = new Client(config);

/**
*Connects to the PostgreSQL database.
*@returns {Promise<void>}
*/
async function sql_connect(): Promise<void> {
    try {
        await client.connect();
        console.log('Database connection established');
    } catch (err) {
        const error = err as Error;
        console.error('Database connection error', error.stack);
        throw error;
    }
}

/**
*Executes a query against the PostgreSQL database.
*@param {string} text - The query text
*@param {any[]} params - The parameters for the query
*@returns {Promise<QueryResult>} - The result of the query
*/
async function sql_query(text: string, params: any[]): Promise<QueryResult> {
    try {
        const start = Date.now();
        const res = await client.query(text, params);
        const duration = Date.now() - start;
        console.log('Executed query', { text, duration, rows: res.rowCount });
        return res;
    } catch (err) {
        const error = err as Error;
        console.error('Query error', error.message, error.stack);
        throw error;
    }
}

/**
*Retrieves a list of all tables in the current database.
*@returns {Promise<string[]>} - The list of table names
*/
async function sql_listTables(): Promise<string[]> {
    const res = await sql_query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'", []);
    return res.rows.map((row: { table_name: string }) => row.table_name);
}

/**
*Retrieves data from a specified table.
*@param {string} tableName - The table name
*@param {string[]} columns - The columns to retrieve
*@returns {Promise<any[]>} - The data from the table
*/
async function sql_getDataFromTable(tableName: string, columns: string[]): Promise<any[]> {
    const columnList = columns.join(', ');
    const res = await sql_query(`SELECT ${columnList} FROM ${tableName}`, []);
    return res.rows;
}

/**
*Closes the database connection.
* @returns {Promise<void>}
*/
async function sql_closeConnection(): Promise<void> {
    try {
        await client.end();
        console.log('Database connection closed');
    } catch (err) {
        const error = err as Error;
        console.error('Error closing connection', error.stack);
        throw error;
    }
}

/**
 * Initialize the plugin.
 * @param router Express Router
 */
export async function init(router: Router): Promise<void> {
    const jsonParser = bodyParser.json();
    sql_connect();
    // Used to check if the server plugin is running
    router.post('/probe', (_req, res) => {
        return res.sendStatus(204);
    });
    router.post('/sql_query', jsonParser, async (req, res) => {
        try {
            const query = req.body.query;
            const result = await sql_query(query, []);
            return res.json(result.rows);
        } catch (error) {
            console.error(chalk.red(MODULE_NAME), 'Request failed', error);
            return res.status(500).send('Internal Server Error');
        }
    });

    console.log(chalk.green(MODULE_NAME), 'Plugin loaded!');
}

export async function exit(): Promise<void> {
    sql_closeConnection();
    console.log(chalk.yellow(MODULE_NAME), 'Plugin exited');
}

export const info: PluginInfo = {
    id: 'postgresql',
    name: 'PostgreSQL Plugin',
    description: 'A simple example plugin for SillyTavern server.',
};

const plugin: Plugin = {
    init,
    exit,
    info,
};

export default plugin;


