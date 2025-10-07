import sqlite3

conn = sqlite3.connect('POSBWbakeshop166.db')
cursor = conn.cursor()

# Check existing rbo tables
tables = ['rbotransactiondiscounttrans', 'rbostoretables']
for table in tables:
    print(f'\n=== {table} ===')
    try:
        cursor.execute(f'PRAGMA table_info({table})')
        cols = cursor.fetchall()
        for col in cols:
            print(f'{col[1]} ({col[2]})')
    except Exception as e:
        print(f'Error: {e}')

conn.close()