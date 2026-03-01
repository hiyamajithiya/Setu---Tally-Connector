const http = require('http');
const xml2js = require('xml2js');
const logger = require('../main/logger');

class TallyConnector {
  constructor(options = {}) {
    this.host = options.host || 'localhost';
    this.port = options.port || 9000;
    this.timeout = options.timeout || 30000;
  }

  updateConfig(options) {
    if (options.host) this.host = options.host;
    if (options.port) this.port = options.port;
  }

  /**
   * Send XML request to Tally
   */
  async sendRequest(xmlData) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.host,
        port: this.port,
        path: '/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/xml',
          'Content-Length': Buffer.byteLength(xmlData, 'utf8')
        },
        timeout: this.timeout
      };

      const req = http.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          resolve(data);
        });
      });

      req.on('error', (error) => {
        logger.error('Tally request error:', error.message);
        reject(new Error(`Failed to connect to Tally: ${error.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Tally request timeout'));
      });

      req.write(xmlData);
      req.end();
    });
  }

  /**
   * Check if Tally is running and get company info
   */
  async checkConnection() {
    // TDL-based request that works with Tally Prime
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>ListOfCompanies</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="ListOfCompanies">
            <TYPE>Company</TYPE>
            <FETCH>NAME</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;

    try {
      const response = await this.sendRequest(xml);

      if (!response) {
        return { connected: false, error: 'No response from Tally' };
      }

      // Check for STATUS=1 (success)
      if (response.includes('<STATUS>1</STATUS>')) {
        // Extract company name from: <COMPANY NAME="CompanyName">
        let companyName = 'Tally Connected';
        const match = response.match(/<COMPANY[^>]*NAME="([^"]+)"/i);
        if (match) {
          companyName = this.decodeXmlEntities(match[1]);
        }

        return {
          connected: true,
          companyName: companyName,
          tallyVersion: 'Tally Prime'
        };
      }

      // Check for error
      const errorMatch = response.match(/<LINEERROR>([^<]+)<\/LINEERROR>/i);
      if (errorMatch) {
        return { connected: false, error: this.decodeXmlEntities(errorMatch[1]) };
      }

      return { connected: false, error: 'Invalid response from Tally' };
    } catch (error) {
      return { connected: false, error: error.message };
    }
  }

  /**
   * Get all ledgers from Tally
   */
  async getLedgers(group = null) {
    // Use TDL-based collection request (works without file export)
    let xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>AllLedgers</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="AllLedgers">
            <TYPE>Ledger</TYPE>
            <FETCH>NAME, PARENT</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;

    try {
      const response = await this.sendRequest(xml);
      logger.info('Tally getLedgers response length:', response ? response.length : 0);

      // Save response to file for debugging
      const fs = require('fs');
      const path = require('path');
      const debugPath = path.join(require('os').homedir(), 'tally_ledgers_response.xml');
      fs.writeFileSync(debugPath, response, 'utf8');
      logger.info('Saved response to:', debugPath);

      const ledgers = this.parseLedgersResponse(response);
      logger.info(`Parsed ${ledgers.length} ledgers from Tally`);
      return ledgers;
    } catch (error) {
      logger.error('Failed to get ledgers:', error);
      throw error;
    }
  }

  /**
   * Parse ledgers from Tally response
   */
  parseLedgersResponse(xmlResponse) {
    const ledgers = [];

    // Tally TDL Collection format:
    // <LEDGER NAME="LedgerName" RESERVEDNAME="">
    //   <PARENT TYPE="String">GroupName</PARENT>
    // </LEDGER>

    // Pattern to match LEDGER with NAME attribute and PARENT with TYPE attribute
    const pattern = /<LEDGER\s+NAME="([^"]+)"[^>]*>[\s\S]*?<PARENT[^>]*>([^<]*)<\/PARENT>/gi;

    let match;
    while ((match = pattern.exec(xmlResponse)) !== null) {
      const name = this.decodeXmlEntities(match[1]).trim();
      const group = this.decodeXmlEntities(match[2]).trim();
      if (name) {
        ledgers.push({ name, group });
      }
    }

    logger.info(`Parsed ${ledgers.length} ledgers, first few:`, JSON.stringify(ledgers.slice(0, 5)));
    return ledgers;
  }

  /**
   * Sync a single invoice to Tally
   */
  async syncInvoice(invoice, mapping) {
    try {
      // First, ensure party ledger exists
      await this.ensurePartyLedger(invoice.client, mapping);

      // Create sales voucher XML
      const voucherXml = this.createSalesVoucherXml(invoice, mapping);

      // Post to Tally
      const response = await this.sendRequest(voucherXml);

      // Check response for success
      const result = this.parseVoucherResponse(response);

      if (result.created > 0) {
        logger.info(`Invoice ${invoice.invoice_number} synced successfully`);
        return { success: true, voucherNumber: invoice.invoice_number };
      } else if (result.errors > 0) {
        throw new Error(`Tally error: ${result.errorMessage || 'Unknown error'}`);
      }

      return { success: true };
    } catch (error) {
      logger.error(`Failed to sync invoice ${invoice.invoice_number}:`, error);
      throw error;
    }
  }

  /**
   * Create or verify party ledger exists
   */
  async ensurePartyLedger(client, mapping) {
    const partyName = client.name;
    const parentGroup = mapping.defaultPartyGroup || 'Sundry Debtors';

    // Check if ledger exists
    const checkXml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Export Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Ledger</REPORTNAME>
        <STATICVARIABLES>
          <LEDGERNAME>${this.escapeXml(partyName)}</LEDGERNAME>
        </STATICVARIABLES>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`;

    try {
      const response = await this.sendRequest(checkXml);

      // If ledger doesn't exist, create it
      if (!response.includes(partyName) || response.includes('does not exist')) {
        await this.createPartyLedger(client, mapping);
      }
    } catch (error) {
      // Ledger might not exist, try to create it
      await this.createPartyLedger(client, mapping);
    }
  }

  /**
   * Create a party ledger in Tally
   */
  async createPartyLedger(client, mapping) {
    const partyName = this.escapeXml(client.name);
    const parentGroup = mapping.defaultPartyGroup || 'Sundry Debtors';

    let addressParts = [];
    if (client.address) addressParts.push(client.address);
    if (client.city) addressParts.push(client.city);
    if (client.state) addressParts.push(client.state);
    if (client.pinCode) addressParts.push(client.pinCode);

    const address = this.escapeXml(addressParts.join(', '));
    const gstin = client.gstin ? this.escapeXml(client.gstin) : '';

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <LEDGER NAME="${partyName}" ACTION="Create">
            <NAME>${partyName}</NAME>
            <PARENT>${this.escapeXml(parentGroup)}</PARENT>
            <ISBILLWISEON>Yes</ISBILLWISEON>
            <AFFECTSSTOCK>No</AFFECTSSTOCK>
            <ISREVENUE>No</ISREVENUE>
            <ISCOSTCENTRESON>No</ISCOSTCENTRESON>
            ${address ? `<ADDRESS.LIST><ADDRESS>${address}</ADDRESS></ADDRESS.LIST>` : ''}
            ${gstin ? `<PARTYGSTIN>${gstin}</PARTYGSTIN>` : ''}
            ${client.state ? `<LEDSTATENAME>${this.escapeXml(client.state)}</LEDSTATENAME>` : ''}
          </LEDGER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;

    try {
      const response = await this.sendRequest(xml);
      const result = this.parseVoucherResponse(response);

      if (result.errors > 0) {
        logger.warn(`Could not create party ledger ${client.name}: ${result.errorMessage}`);
      } else {
        logger.info(`Created party ledger: ${client.name}`);
      }
    } catch (error) {
      logger.warn(`Failed to create party ledger ${client.name}:`, error.message);
    }
  }

  /**
   * Create sales voucher XML for an invoice
   */
  createSalesVoucherXml(invoice, mapping) {
    const partyName = this.escapeXml(invoice.client.name);
    const invoiceNumber = this.escapeXml(invoice.invoice_number);
    const invoiceDate = this.formatTallyDate(invoice.invoice_date);

    // Calculate GST amounts
    const { cgst, sgst, igst } = this.calculateGst(invoice, mapping);

    // Build narration
    let narration = '';
    if (invoice.notes) {
      narration = invoice.notes.replace(/\n/g, ' ').replace(/\r/g, '');
    }
    narration += ` [Invoice ${invoice.invoice_number} - Imported from NexInvo]`;
    narration = this.escapeXml(narration.trim());

    // Build ledger entries
    let ledgerEntries = '';

    // Party (Debit) - Total amount
    ledgerEntries += `
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>${partyName}</LEDGERNAME>
          <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
          <AMOUNT>-${invoice.total_amount}</AMOUNT>
        </ALLLEDGERENTRIES.LIST>`;

    // Sales (Credit) - Subtotal
    if (invoice.subtotal && parseFloat(invoice.subtotal) > 0) {
      ledgerEntries += `
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>${this.escapeXml(mapping.salesLedger || 'Sales')}</LEDGERNAME>
          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
          <AMOUNT>${invoice.subtotal}</AMOUNT>
        </ALLLEDGERENTRIES.LIST>`;
    }

    // CGST (Credit)
    if (cgst > 0 && mapping.cgstLedger) {
      ledgerEntries += `
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>${this.escapeXml(mapping.cgstLedger)}</LEDGERNAME>
          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
          <AMOUNT>${cgst.toFixed(2)}</AMOUNT>
        </ALLLEDGERENTRIES.LIST>`;
    }

    // SGST (Credit)
    if (sgst > 0 && mapping.sgstLedger) {
      ledgerEntries += `
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>${this.escapeXml(mapping.sgstLedger)}</LEDGERNAME>
          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
          <AMOUNT>${sgst.toFixed(2)}</AMOUNT>
        </ALLLEDGERENTRIES.LIST>`;
    }

    // IGST (Credit)
    if (igst > 0 && mapping.igstLedger) {
      ledgerEntries += `
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>${this.escapeXml(mapping.igstLedger)}</LEDGERNAME>
          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
          <AMOUNT>${igst.toFixed(2)}</AMOUNT>
        </ALLLEDGERENTRIES.LIST>`;
    }

    // Round Off (Credit/Debit)
    if (invoice.round_off && parseFloat(invoice.round_off) !== 0 && mapping.roundOffLedger) {
      const roundOff = parseFloat(invoice.round_off);
      ledgerEntries += `
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>${this.escapeXml(mapping.roundOffLedger)}</LEDGERNAME>
          <ISDEEMEDPOSITIVE>${roundOff < 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>
          <AMOUNT>${Math.abs(roundOff).toFixed(2)}</AMOUNT>
        </ALLLEDGERENTRIES.LIST>`;
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="Sales" ACTION="Create">
            <DATE>${invoiceDate}</DATE>
            <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${invoiceNumber}</VOUCHERNUMBER>
            <REFERENCE>${invoiceNumber}</REFERENCE>
            <PARTYLEDGERNAME>${partyName}</PARTYLEDGERNAME>
            <NARRATION>${narration}</NARRATION>
            <ISINVOICE>Yes</ISINVOICE>
            <EFFECTIVEDATE>${invoiceDate}</EFFECTIVEDATE>
            ${ledgerEntries}
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;

    return xml;
  }

  /**
   * Calculate GST based on state codes
   */
  calculateGst(invoice, mapping) {
    const taxAmount = parseFloat(invoice.tax_amount) || 0;

    // Get state codes (first 2 digits of GSTIN)
    const companyStateCode = mapping.companyGstin ? mapping.companyGstin.substring(0, 2) : '';
    const clientStateCode = invoice.client.gstin ? invoice.client.gstin.substring(0, 2) : '';

    // Determine if inter-state or intra-state
    const isInterState = companyStateCode && clientStateCode && companyStateCode !== clientStateCode;

    if (isInterState) {
      // Inter-state: 100% IGST
      return {
        cgst: 0,
        sgst: 0,
        igst: taxAmount
      };
    } else {
      // Intra-state: 50% CGST + 50% SGST
      return {
        cgst: taxAmount / 2,
        sgst: taxAmount / 2,
        igst: 0
      };
    }
  }

  /**
   * Parse voucher import response
   */
  parseVoucherResponse(xmlResponse) {
    const result = {
      created: 0,
      altered: 0,
      errors: 0,
      errorMessage: ''
    };

    // Extract counts using regex
    const createdMatch = xmlResponse.match(/<CREATED>(\d+)<\/CREATED>/i);
    const alteredMatch = xmlResponse.match(/<ALTERED>(\d+)<\/ALTERED>/i);
    const errorsMatch = xmlResponse.match(/<ERRORS>(\d+)<\/ERRORS>/i);
    const lineErrorMatch = xmlResponse.match(/<LINEERROR>([^<]*)<\/LINEERROR>/i);

    if (createdMatch) result.created = parseInt(createdMatch[1]);
    if (alteredMatch) result.altered = parseInt(alteredMatch[1]);
    if (errorsMatch) result.errors = parseInt(errorsMatch[1]);
    if (lineErrorMatch && lineErrorMatch[1]) {
      result.errorMessage = this.decodeXmlEntities(lineErrorMatch[1]);
    }

    return result;
  }

  /**
   * Check if a voucher already exists in Tally
   */
  async checkVoucherExists(voucherNumber, voucherDate) {
    const formattedDate = this.formatTallyDate(voucherDate);

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Export Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Voucher Register</REPORTNAME>
        <STATICVARIABLES>
          <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
          <SVFROMDATE>${formattedDate}</SVFROMDATE>
          <SVTODATE>${formattedDate}</SVTODATE>
        </STATICVARIABLES>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`;

    try {
      const response = await this.sendRequest(xml);
      return response.includes(voucherNumber);
    } catch (error) {
      logger.warn('Could not check voucher existence:', error.message);
      return false;
    }
  }

  /**
   * Format date for Tally (YYYYMMDD)
   */
  formatTallyDate(dateStr) {
    const date = new Date(dateStr);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
  }

  /**
   * Escape XML special characters
   */
  escapeXml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Decode XML entities
   */
  decodeXmlEntities(str) {
    if (!str) return '';
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
  }

  /**
   * Parse XML response to JSON
   */
  async parseXmlResponse(xmlString) {
    return new Promise((resolve, reject) => {
      const parser = new xml2js.Parser({
        explicitArray: true,
        ignoreAttrs: false
      });

      parser.parseString(xmlString, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
  }

  /**
   * Get all parties (Sundry Debtors) from Tally for import as Clients
   */
  async getParties() {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>AllParties</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="AllParties">
            <TYPE>Ledger</TYPE>
            <CHILDOF>Sundry Debtors</CHILDOF>
            <BELONGSTO>Yes</BELONGSTO>
            <FETCH>NAME, PARENT, ADDRESS, LEDSTATENAME, PINCODE, LEDGERPHONE, LEDGERMOBILE, EMAIL, PARTYGSTIN</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;
    try {
      const response = await this.sendRequest(xml);
      return this.parsePartiesResponse(response);
    } catch (error) {
      logger.error("Failed to get parties:", error);
      throw error;
    }
  }

  parsePartiesResponse(xmlResponse) {
    const parties = [];
    const pattern = /<LEDGER\s+NAME="([^"]+)"[^>]*>([\s\S]*?)<\/LEDGER>/gi;
    let match;
    while ((match = pattern.exec(xmlResponse)) !== null) {
      const name = this.decodeXmlEntities(match[1]).trim();
      const content = match[2];
      if (name) {
        parties.push({
          name: name,
          group: this.extractTagValue(content, "PARENT"),
          address: this.extractTagValue(content, "ADDRESS"),
          state: this.extractTagValue(content, "LEDSTATENAME"),
          pincode: this.extractTagValue(content, "PINCODE"),
          phone: this.extractTagValue(content, "LEDGERPHONE") || this.extractTagValue(content, "LEDGERMOBILE"),
          email: this.extractTagValue(content, "EMAIL"),
          gstin: this.extractTagValue(content, "PARTYGSTIN")
        });
      }
    }
    return parties;
  }

  async getStockItems() {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>AllStockItems</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="AllStockItems">
            <TYPE>StockItem</TYPE>
            <FETCH>NAME, PARENT, BASEUNITS, HSNCODE, DESCRIPTION, OPENINGRATE</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;
    try {
      const response = await this.sendRequest(xml);
      return this.parseStockItemsResponse(response);
    } catch (error) {
      logger.error("Failed to get stock items:", error);
      throw error;
    }
  }

  parseStockItemsResponse(xmlResponse) {
    const items = [];
    const pattern = /<STOCKITEM\s+NAME="([^"]+)"[^>]*>([\s\S]*?)<\/STOCKITEM>/gi;
    let match;
    while ((match = pattern.exec(xmlResponse)) !== null) {
      const name = this.decodeXmlEntities(match[1]).trim();
      const content = match[2];
      if (name) {
        items.push({
          name: name,
          group: this.extractTagValue(content, "PARENT"),
          unit: this.extractTagValue(content, "BASEUNITS"),
          hsn_code: this.extractTagValue(content, "HSNCODE"),
          description: this.extractTagValue(content, "DESCRIPTION"),
          rate: parseFloat(this.extractTagValue(content, "OPENINGRATE")) || 0
        });
      }
    }
    return items;
  }

  extractTagValue(content, tagName) {
    const pattern = new RegExp(`<${tagName}[^>]*>([^<]*)</${tagName}>`, "i");
    const match = content.match(pattern);
    return match ? this.decodeXmlEntities(match[1]).trim() : "";
  }

  /**
   * Get Sales Vouchers (Invoices) from Tally for a date range
   */
  async getSalesVouchers(startDate, endDate) {
    const formattedStartDate = this.formatTallyDate(startDate);
    const formattedEndDate = this.formatTallyDate(endDate);

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>SalesVouchers</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        <SVFROMDATE>${formattedStartDate}</SVFROMDATE>
        <SVTODATE>${formattedEndDate}</SVTODATE>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="SalesVouchers">
            <TYPE>Voucher</TYPE>
            <FILTER>SalesVchFilter</FILTER>
            <FETCH>DATE, VOUCHERNUMBER, REFERENCE, PARTYLEDGERNAME, AMOUNT, NARRATION, VOUCHERTYPENAME</FETCH>
          </COLLECTION>
          <SYSTEM TYPE="Formulae" NAME="SalesVchFilter">
            $VOUCHERTYPENAME = "Sales" AND NOT $$IsEmpty:$VOUCHERNUMBER
          </SYSTEM>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;

    try {
      const response = await this.sendRequest(xml);
      logger.info('Tally getSalesVouchers response length:', response ? response.length : 0);
      return this.parseSalesVouchersResponse(response);
    } catch (error) {
      logger.error('Failed to get sales vouchers:', error);
      throw error;
    }
  }

  /**
   * Parse Sales Vouchers from Tally response
   */
  parseSalesVouchersResponse(xmlResponse) {
    const vouchers = [];

    // Pattern to match VOUCHER elements
    const pattern = /<VOUCHER[^>]*>([\s\S]*?)<\/VOUCHER>/gi;
    let match;

    while ((match = pattern.exec(xmlResponse)) !== null) {
      const content = match[1];

      // Extract voucher details
      const voucherNumber = this.extractTagValue(content, 'VOUCHERNUMBER');
      const reference = this.extractTagValue(content, 'REFERENCE');
      const partyLedger = this.extractTagValue(content, 'PARTYLEDGERNAME');
      const dateStr = this.extractTagValue(content, 'DATE');
      const amount = this.extractTagValue(content, 'AMOUNT');
      const narration = this.extractTagValue(content, 'NARRATION');
      const voucherType = this.extractTagValue(content, 'VOUCHERTYPENAME');

      if (voucherNumber && voucherType === 'Sales') {
        // Parse Tally date format (YYYYMMDD) to ISO format
        let invoiceDate = '';
        if (dateStr && dateStr.length === 8) {
          invoiceDate = `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
        }

        vouchers.push({
          voucher_number: voucherNumber,
          reference: reference || voucherNumber,
          party_name: partyLedger,
          invoice_date: invoiceDate,
          total_amount: Math.abs(parseFloat(amount)) || 0,
          narration: narration,
          voucher_type: voucherType
        });
      }
    }

    logger.info(`Parsed ${vouchers.length} sales vouchers from Tally`);
    return vouchers;
  }
}

module.exports = TallyConnector;