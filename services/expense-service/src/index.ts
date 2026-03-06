/**
 * @module @breeze/expense-service
 * Expense Service entry point — trip expense tracking and splitting.
 */
const SERVICE_NAME = 'expense-service';
const PORT = parseInt(process.env['PORT'] ?? '3009', 10);

async function main(): Promise<void> {
    console.log(`[${SERVICE_NAME}] Starting on port ${PORT}...`);
    console.log(`[${SERVICE_NAME}] Service scaffold ready. Implement expense tracking here.`);
}

void main();
