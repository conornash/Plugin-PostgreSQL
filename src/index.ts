import bodyParser from 'body-parser';
import { Router } from 'express';
import { Chalk } from 'chalk';
import { Pool, QueryResult } from 'pg';
import { BlobServiceClient, StorageSharedKeyCredential, generateBlobSASQueryParameters, BlobSASPermissions, SASProtocol } from "@azure/storage-blob";


interface DatabaseConfig {
    user: string;
    host: string;
    database: string;
    password: string;
    port: number;
    max: number;
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


const constructBlobUrlWithAccountKey = async (
    accountName: string,
    containerName: string,
    blobName: string,
    accountKey: string
): Promise<string> => {
    const sharedKeyCredential = new StorageSharedKeyCredential(
        accountName,
        accountKey
    );

    const blobServiceClient = new BlobServiceClient(
        `https://${accountName}.blob.core.windows.net`,
        sharedKeyCredential
    );

    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blobClient = containerClient.getBlobClient(blobName);

    // Generate SAS token with short-lived access
    const startsOn = new Date();
    const expiresOn = new Date(startsOn);
    expiresOn.setMinutes(startsOn.getMinutes() + 15); // 15 minutes validity

    const sasOptions = {
        containerName,
        blobName,
        permissions: BlobSASPermissions.parse("r"), // Read-only
        startsOn,
        expiresOn,
        protocol: SASProtocol.Https
    };

    const sasToken = generateBlobSASQueryParameters(
        sasOptions,
        sharedKeyCredential
    ).toString();

    return `${blobClient.url}?${sasToken}`;
};

const chalk = new Chalk();
const MODULE_NAME = '[SillyTavern-PostgreSQL]';

// Set up a PostgreSQL Client
const shannon_config: DatabaseConfig & { ssl: any } = {
    user: String(process.env.SHANNON_USER),
    host: String(process.env.SHANNON_HOST),
    database: String(process.env.SHANNON_DATABASE),
    password: String(process.env.SHANNON_PASSWORD),
    port: Number(process.env.SHANNON_PORT),
    max: 3,
    ssl: {
        rejectUnauthorized: false
    }
}

const shannon_pool = new Pool(shannon_config);

const tolka_config: DatabaseConfig & { ssl: any } = {
    user: String(process.env.TOLKA_USER),
    host: String(process.env.TOLKA_HOST),
    database: String(process.env.TOLKA_DATABASE),
    password: String(process.env.TOLKA_PASSWORD),
    port: Number(process.env.TOLKA_PORT),
    max: 3,
    ssl: {
        rejectUnauthorized: false
    }
}

const tolka_pool = new Pool(tolka_config);

const liffey_config: DatabaseConfig & { ssl: any } = {
    user: String(process.env.LIFFEY_USER),
    host: String(process.env.LIFFEY_HOST),
    database: String(process.env.LIFFEY_DATABASE),
    password: String(process.env.LIFFEY_PASSWORD),
    port: Number(process.env.LIFFEY_PORT),
    max: 3,
    ssl: {
        rejectUnauthorized: false
    }
}

const liffey_pool = new Pool(liffey_config);

// Set up Azure Blob Storage connection
const azure_blob_storage_config = {
    accountName: String(process.env.BLOB_STORAGE_ACCOUNT_NAME),
    containerName: String(process.env.BLOB_STORAGE_CONTAINER_NAME),
    accountKey: String(process.env.BLOB_STORAGE_ACCOUNT_KEY)
}

type BlobConfig = typeof azure_blob_storage_config;
type WithBlobName = BlobConfig & { blobName: string };

// Function now accepts the combined config
const getBlobUrl = async (config: WithBlobName) =>
    constructBlobUrlWithAccountKey(
        config.accountName,
        config.containerName,
        config.blobName,
        config.accountKey
    );

// Usage example
const downloadBlobNameUrl = async (blobName: string) => {
    const config: WithBlobName = {
        ...azure_blob_storage_config,
        blobName
    };
    const securedUrl = await getBlobUrl(config);
    return securedUrl;
};


/**
*Connects to the PostgreSQL database.
*@returns {Promise<void>}
*/
async function sql_connect(pool: Pool): Promise<void> {
    try {
        const client = await pool.connect();
        console.log('Database connection established');
        client.release();  // Release the client back to the pool
    } catch (err) {
        const error = err as Error & { code?: string };
        console.error('Database connection error:', error.message, error.stack);

        if (error.code === 'ETIMEDOUT') {
            console.log('Database connection timeout');
        } else {
            throw error;
        }
    }
}

/**
*Executes a query against the PostgreSQL database.
*@param {string} text - The query text
*@param {any[]} params - The parameters for the query
*@returns {Promise<QueryResult>} - The result of the query
*/
async function sql_query(pool: Pool, text: string, params: any[]): Promise<QueryResult> {
    const client = await pool.connect();
    try {
        console.log(chalk.green(MODULE_NAME), text);
        const start = Date.now();
        const res = await client.query(text, params);
        const duration = Date.now() - start;
        console.log('Executed query', { text, duration, rows: res.rowCount });
        return res;
    } catch (err) {
        const error = err as Error & { code?: string };
        console.error('Query error', error.message, error.stack);
        throw error;
    } finally {
        client.release();
    }
}

/**
*Retrieves a list of all tables in the current database.
*@returns {Promise<string[]>} - The list of table names
*/
async function sql_listTables(): Promise<string[]> {
    const res = await sql_query(shannon_pool, "SELECT table_name FROM information_schema.tables WHERE table_schema='public'", []);
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
    const res = await sql_query(shannon_pool, `SELECT ${columnList} FROM ${tableName}`, []);
    return res.rows;
}

/**
*Closes all database connections managed by the pool.*
*@returns {Promise<void>} A promise that resolves when all connections have been closed.*
*/
async function sql_closeConnection(pool: Pool): Promise<void> {
    try {
        await pool.end();
        console.log('All database connections have been closed.');
    } catch (err) {
        const error = err as Error;
        console.error('Error closing database connections:', error.message, error.stack);
        throw error;
    }
}

/**
 * Initialize the plugin.
 * @param router Express Router
 */
export async function init(router: Router): Promise<void> {
    const jsonParser = bodyParser.json();
    // Used to check if the server plugin is running
    router.post('/probe', (_req, res) => {
        return res.sendStatus(204);
    });
    router.post('/sql_query', jsonParser, async (req, res) => {
        try {
            sql_connect(shannon_pool);
            const query = req.body.query;
            const result = await sql_query(shannon_pool, query, []);
            return res.json(result.rows);
        } catch (error) {
            console.error(chalk.red(MODULE_NAME), 'Request failed', error);
            return res.status(500).send('Internal Server Error');
        }
    });
    router.post('/shannon_sql query', jsonParser, async (req, res) => {
        try {
            sql_connect(shannon_pool);
            const query = req.body.query;
            const result = await sql_query(shannon_pool, query, []);
            return res.json(result.rows);
        } catch (error) {
            console.error(chalk.red(MODULE_NAME), 'Request failed', error);
            return res.status(500).send('Internal Server Error');
        }
    });
    router.post('/tolka_sql_query', jsonParser, async (req, res) => {
        try {
            sql_connect(tolka_pool);
            const query = req.body.query;
            const result = await sql_query(tolka_pool, query, []);
            return res.json(result.rows);
        } catch (error) {
            console.error(chalk.red(MODULE_NAME), 'Request failed', error);
            return res.status(500).send('Internal Server Error');
        }
    });
    router.post('/get_blob_url', jsonParser, async (req, res) => {
        try {
            const blobName = req.body.blobName;
            const result = await downloadBlobNameUrl(blobName);
            return res.json({ blob_url: result });
        } catch (error) {
            console.error(chalk.red(MODULE_NAME), 'Request failed', error);
            return res.status(500).send('Internal Server Error');
        }
    });

    console.log(chalk.green(MODULE_NAME), 'Plugin loaded!');
}

export async function exit(): Promise<void> {
    sql_closeConnection(shannon_pool);
    sql_closeConnection(tolka_pool);
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
