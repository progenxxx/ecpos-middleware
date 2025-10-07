import sqlite3
import pandas as pd
import json
from datetime import datetime

def transfer_rbo_data(source_db_path, destination_format='csv'):
    """
    Transfer data from rbotransactiondiscounttrans and rbostoretables tables

    Args:
        source_db_path (str): Path to the source SQLite database
        destination_format (str): Output format - 'csv', 'json', 'excel', or 'sql'
    """

    # Connect to source database
    conn = sqlite3.connect(source_db_path)

    try:
        # Extract data from rbotransactiondiscounttrans
        print("Extracting rbotransactiondiscounttrans data...")
        discount_trans_df = pd.read_sql_query(
            "SELECT * FROM rbotransactiondiscounttrans", conn
        )
        print(f"Found {len(discount_trans_df)} records in rbotransactiondiscounttrans")

        # Extract data from rbostoretables
        print("Extracting rbostoretables data...")
        store_tables_df = pd.read_sql_query(
            "SELECT * FROM rbostoretables", conn
        )
        print(f"Found {len(store_tables_df)} records in rbostoretables")

        # Create timestamp for file naming
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

        if destination_format.lower() == 'csv':
            # Export to CSV files
            discount_trans_file = f"rbotransactiondiscounttrans_{timestamp}.csv"
            store_tables_file = f"rbostoretables_{timestamp}.csv"

            discount_trans_df.to_csv(discount_trans_file, index=False)
            store_tables_df.to_csv(store_tables_file, index=False)

            print(f"Data exported to:")
            print(f"  - {discount_trans_file}")
            print(f"  - {store_tables_file}")

        elif destination_format.lower() == 'json':
            # Export to JSON files
            discount_trans_file = f"rbotransactiondiscounttrans_{timestamp}.json"
            store_tables_file = f"rbostoretables_{timestamp}.json"

            discount_trans_df.to_json(discount_trans_file, orient='records', indent=2)
            store_tables_df.to_json(store_tables_file, orient='records', indent=2)

            print(f"Data exported to:")
            print(f"  - {discount_trans_file}")
            print(f"  - {store_tables_file}")

        elif destination_format.lower() == 'excel':
            # Export to Excel file with multiple sheets
            excel_file = f"rbo_data_{timestamp}.xlsx"
            with pd.ExcelWriter(excel_file, engine='openpyxl') as writer:
                discount_trans_df.to_excel(writer, sheet_name='discount_trans', index=False)
                store_tables_df.to_excel(writer, sheet_name='store_tables', index=False)

            print(f"Data exported to: {excel_file}")

        elif destination_format.lower() == 'sql':
            # Export to SQL file
            sql_file = f"rbo_data_{timestamp}.sql"
            with open(sql_file, 'w') as f:
                # Write discount transactions
                f.write("-- rbotransactiondiscounttrans data\n")
                f.write("CREATE TABLE IF NOT EXISTS rbotransactiondiscounttrans (\n")
                for i, col in enumerate(discount_trans_df.columns):
                    f.write(f"    {col} TEXT")
                    if i < len(discount_trans_df.columns) - 1:
                        f.write(",")
                    f.write("\n")
                f.write(");\n\n")

                for _, row in discount_trans_df.iterrows():
                    values = [f"'{str(val).replace(\"'\", \"''\")}'" if pd.notna(val) else 'NULL' for val in row]
                    f.write(f"INSERT INTO rbotransactiondiscounttrans VALUES ({', '.join(values)});\n")

                f.write("\n\n-- rbostoretables data\n")
                f.write("CREATE TABLE IF NOT EXISTS rbostoretables (\n")
                for i, col in enumerate(store_tables_df.columns):
                    f.write(f"    {col} TEXT")
                    if i < len(store_tables_df.columns) - 1:
                        f.write(",")
                    f.write("\n")
                f.write(");\n\n")

                for _, row in store_tables_df.iterrows():
                    values = [f"'{str(val).replace(\"'\", \"''\")}'" if pd.notna(val) else 'NULL' for val in row]
                    f.write(f"INSERT INTO rbostoretables VALUES ({', '.join(values)});\n")

            print(f"Data exported to: {sql_file}")

        # Return dataframes for further processing if needed
        return {
            'discount_trans': discount_trans_df,
            'store_tables': store_tables_df
        }

    except Exception as e:
        print(f"Error during data transfer: {str(e)}")
        return None

    finally:
        conn.close()

def transfer_to_new_database(source_db_path, destination_db_path):
    """
    Transfer rbo data to a new SQLite database

    Args:
        source_db_path (str): Path to source database
        destination_db_path (str): Path to destination database
    """

    source_conn = sqlite3.connect(source_db_path)
    dest_conn = sqlite3.connect(destination_db_path)

    try:
        # Read data from source
        discount_trans_df = pd.read_sql_query("SELECT * FROM rbotransactiondiscounttrans", source_conn)
        store_tables_df = pd.read_sql_query("SELECT * FROM rbostoretables", source_conn)

        # Write to destination
        discount_trans_df.to_sql('rbotransactiondiscounttrans', dest_conn, if_exists='replace', index=False)
        store_tables_df.to_sql('rbostoretables', dest_conn, if_exists='replace', index=False)

        print(f"Data successfully transferred to {destination_db_path}")
        print(f"Tables created:")
        print(f"  - rbotransactiondiscounttrans ({len(discount_trans_df)} records)")
        print(f"  - rbostoretables ({len(store_tables_df)} records)")

    except Exception as e:
        print(f"Error during database transfer: {str(e)}")

    finally:
        source_conn.close()
        dest_conn.close()

if __name__ == "__main__":
    # Database path
    db_path = r"D:\MARK ADS\fs-branch2\Mware-main\Mware-main\POSBWbakeshop166.db"

    # Example usage - export to CSV
    print("=== Exporting to CSV ===")
    data = transfer_rbo_data(db_path, 'csv')

    print("\n=== Exporting to JSON ===")
    transfer_rbo_data(db_path, 'json')

    print("\n=== Exporting to Excel ===")
    transfer_rbo_data(db_path, 'excel')

    print("\n=== Exporting to SQL ===")
    transfer_rbo_data(db_path, 'sql')

    print("\n=== Transferring to new database ===")
    transfer_to_new_database(db_path, "rbo_data_backup.db")

    # Display sample data if transfer was successful
    if data:
        print("\n=== Sample Data Preview ===")
        print("\nDiscount Transactions (first 5 rows):")
        print(data['discount_trans'].head())

        print("\nStore Tables (first 5 rows):")
        print(data['store_tables'].head())