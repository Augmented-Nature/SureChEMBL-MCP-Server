#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import axios, { AxiosInstance } from 'axios';

// SureChEMBL API interfaces
interface ChemicalSearchResult {
  id: string;
  chemical_id: string;
  name: string;
  smiles?: string;
  inchi?: string;
  inchi_key?: string;
  mol_weight?: number;
  is_element?: string;
  global_frequency?: number;
  mchem_struct_alert?: string;
}

interface DocumentContent {
  doc_id: string;
  doc_version?: string;
  date_added?: string;
  contents: {
    patentDocument: {
      bibliographicData: {
        publicationReference: Array<{
          ucid: string;
          documentId: Array<{
            country: { content: string };
            docNumber: string;
            kind: string;
            date: string;
            lang?: string;
          }>;
        }>;
        inventionTitles?: Array<{
          lang: string;
          title: string;
        }>;
      };
      abstracts?: Array<{
        lang: string;
        section: {
          content: string;
          annotations?: Array<{
            name: string;
            start: number;
            end: number;
            category: string;
            globalFrequency?: number;
            chemicalIds?: number[];
          }>;
        };
      }>;
      descriptions?: Array<{
        lang: string;
        section: {
          content: string;
        };
      }>;
    };
  };
}

interface PatentFamily {
  members: { [key: string]: any };
}

// Type guards and validation functions
const isValidSearchArgs = (
  args: any
): args is { query: string; limit?: number; offset?: number } => {
  return (
    typeof args === 'object' &&
    args !== null &&
    typeof args.query === 'string' &&
    args.query.length > 0 &&
    (args.limit === undefined || (typeof args.limit === 'number' && args.limit > 0 && args.limit <= 1000)) &&
    (args.offset === undefined || (typeof args.offset === 'number' && args.offset >= 0))
  );
};

const isValidIdArgs = (
  args: any
): args is { id: string } => {
  return (
    typeof args === 'object' &&
    args !== null &&
    typeof args.id === 'string' &&
    args.id.length > 0
  );
};

const isValidDocumentArgs = (
  args: any
): args is { document_id: string; include_annotations?: boolean } => {
  return (
    typeof args === 'object' &&
    args !== null &&
    typeof args.document_id === 'string' &&
    args.document_id.length > 0 &&
    (args.include_annotations === undefined || typeof args.include_annotations === 'boolean')
  );
};

const isValidStructureArgs = (
  args: any
): args is { smiles?: string; inchi?: string; limit?: number } => {
  return (
    typeof args === 'object' &&
    args !== null &&
    (args.smiles !== undefined || args.inchi !== undefined) &&
    (args.smiles === undefined || typeof args.smiles === 'string') &&
    (args.inchi === undefined || typeof args.inchi === 'string') &&
    (args.limit === undefined || (typeof args.limit === 'number' && args.limit > 0 && args.limit <= 1000))
  );
};

const isValidImageArgs = (
  args: any
): args is { structure: string; height?: number; width?: number } => {
  return (
    typeof args === 'object' &&
    args !== null &&
    typeof args.structure === 'string' &&
    args.structure.length > 0 &&
    (args.height === undefined || (typeof args.height === 'number' && args.height > 0 && args.height <= 1000)) &&
    (args.width === undefined || (typeof args.width === 'number' && args.width > 0 && args.width <= 1000))
  );
};

const isValidExportArgs = (
  args: any
): args is { chemical_ids: string[]; output_type?: string; kind?: string } => {
  return (
    typeof args === 'object' &&
    args !== null &&
    Array.isArray(args.chemical_ids) &&
    args.chemical_ids.length > 0 &&
    args.chemical_ids.length <= 100 &&
    args.chemical_ids.every((id: any) => typeof id === 'string' && id.length > 0) &&
    (args.output_type === undefined || ['csv', 'xml'].includes(args.output_type)) &&
    (args.kind === undefined || ['cid', 'smiles'].includes(args.kind))
  );
};

class SureChEMBLServer {
  private server: Server;
  private apiClient: AxiosInstance;

  constructor() {
    this.server = new Server(
      {
        name: 'surechembl-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      }
    );

    // Initialize SureChEMBL API client
    this.apiClient = axios.create({
      baseURL: 'https://www.surechembl.org/api',
      timeout: 30000,
      headers: {
        'User-Agent': 'SureChEMBL-MCP-Server/1.0.0',
        'Accept': 'application/json',
      },
    });

    this.setupResourceHandlers();
    this.setupToolHandlers();

    // Error handling
    this.server.onerror = (error: any) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupResourceHandlers() {
    // List available resource templates
    this.server.setRequestHandler(
      ListResourceTemplatesRequestSchema,
      async () => ({
        resourceTemplates: [
          {
            uriTemplate: 'surechembl://document/{doc_id}',
            name: 'SureChEMBL patent document',
            mimeType: 'application/json',
            description: 'Complete patent document content with chemical annotations',
          },
          {
            uriTemplate: 'surechembl://chemical/{chem_id}',
            name: 'SureChEMBL chemical compound',
            mimeType: 'application/json',
            description: 'Chemical compound information and properties',
          },
          {
            uriTemplate: 'surechembl://family/{patent_id}',
            name: 'SureChEMBL patent family',
            mimeType: 'application/json',
            description: 'Patent family members and relationships',
          },
          {
            uriTemplate: 'surechembl://search/{query}',
            name: 'SureChEMBL search results',
            mimeType: 'application/json',
            description: 'Chemical search results for the query',
          },
        ],
      })
    );

    // Handle resource requests
    this.server.setRequestHandler(
      ReadResourceRequestSchema,
      async (request: any) => {
        const uri = request.params.uri;

        // Handle document content requests
        const documentMatch = uri.match(/^surechembl:\/\/document\/([A-Z0-9-]+)$/);
        if (documentMatch) {
          const docId = documentMatch[1];
          try {
            const response = await this.apiClient.get(`/document/${docId}/contents`);
            return {
              contents: [
                {
                  uri: request.params.uri,
                  mimeType: 'application/json',
                  text: JSON.stringify(response.data, null, 2),
                },
              ],
            };
          } catch (error) {
            throw new McpError(
              ErrorCode.InternalError,
              `Failed to fetch document ${docId}: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
          }
        }

        // Handle chemical info requests
        const chemicalMatch = uri.match(/^surechembl:\/\/chemical\/([0-9]+)$/);
        if (chemicalMatch) {
          const chemId = chemicalMatch[1];
          try {
            const response = await this.apiClient.get(`/chemical/id/${chemId}`);
            return {
              contents: [
                {
                  uri: request.params.uri,
                  mimeType: 'application/json',
                  text: JSON.stringify(response.data, null, 2),
                },
              ],
            };
          } catch (error) {
            throw new McpError(
              ErrorCode.InternalError,
              `Failed to fetch chemical ${chemId}: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
          }
        }

        // Handle patent family requests
        const familyMatch = uri.match(/^surechembl:\/\/family\/([A-Z0-9-]+)$/);
        if (familyMatch) {
          const patentId = familyMatch[1];
          try {
            const response = await this.apiClient.get(`/document/${patentId}/family/members`);
            return {
              contents: [
                {
                  uri: request.params.uri,
                  mimeType: 'application/json',
                  text: JSON.stringify(response.data, null, 2),
                },
              ],
            };
          } catch (error) {
            throw new McpError(
              ErrorCode.InternalError,
              `Failed to fetch patent family ${patentId}: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
          }
        }

        // Handle search requests
        const searchMatch = uri.match(/^surechembl:\/\/search\/(.+)$/);
        if (searchMatch) {
          const query = decodeURIComponent(searchMatch[1]);
          try {
            const response = await this.apiClient.get(`/chemical/name/${query}`);
            return {
              contents: [
                {
                  uri: request.params.uri,
                  mimeType: 'application/json',
                  text: JSON.stringify(response.data, null, 2),
                },
              ],
            };
          } catch (error) {
            throw new McpError(
              ErrorCode.InternalError,
              `Failed to search chemicals: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
          }
        }

        throw new McpError(
          ErrorCode.InvalidRequest,
          `Invalid URI format: ${uri}`
        );
      }
    );
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        // Document & Patent Search (4 tools)
        {
          name: 'search_patents',
          description: 'Search patents by text, keywords, or identifiers in SureChEMBL database',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query (keywords, patent numbers, or text)' },
              limit: { type: 'number', description: 'Number of results to return (1-1000, default: 25)', minimum: 1, maximum: 1000 },
              offset: { type: 'number', description: 'Number of results to skip (default: 0)', minimum: 0 },
            },
            required: ['query'],
          },
        },
        {
          name: 'get_document_content',
          description: 'Get complete patent document content with chemical annotations by document ID',
          inputSchema: {
            type: 'object',
            properties: {
              document_id: { type: 'string', description: 'Patent document ID (e.g., WO-2020096695-A1)' },
            },
            required: ['document_id'],
          },
        },
        {
          name: 'get_patent_family',
          description: 'Get patent family members and relationships for a patent',
          inputSchema: {
            type: 'object',
            properties: {
              patent_id: { type: 'string', description: 'Patent ID to find family members for' },
            },
            required: ['patent_id'],
          },
        },
        {
          name: 'search_by_patent_number',
          description: 'Search for patents by specific patent numbers or publication numbers',
          inputSchema: {
            type: 'object',
            properties: {
              patent_number: { type: 'string', description: 'Patent or publication number' },
            },
            required: ['patent_number'],
          },
        },
        // Chemical Search & Retrieval (4 tools)
        {
          name: 'search_chemicals_by_name',
          description: 'Search for chemicals by name, synonym, or common name',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Chemical name or synonym to search for' },
              limit: { type: 'number', description: 'Number of results to return (1-1000, default: 25)', minimum: 1, maximum: 1000 },
            },
            required: ['name'],
          },
        },
        {
          name: 'get_chemical_by_id',
          description: 'Get detailed chemical information by SureChEMBL chemical ID',
          inputSchema: {
            type: 'object',
            properties: {
              chemical_id: { type: 'string', description: 'SureChEMBL chemical ID (numeric)' },
            },
            required: ['chemical_id'],
          },
        },
        {
          name: 'search_by_smiles',
          description: 'Search for chemicals by SMILES structure notation',
          inputSchema: {
            type: 'object',
            properties: {
              smiles: { type: 'string', description: 'SMILES string of the chemical structure' },
              limit: { type: 'number', description: 'Number of results to return (1-1000, default: 25)', minimum: 1, maximum: 1000 },
            },
            required: ['smiles'],
          },
        },
        {
          name: 'search_by_inchi',
          description: 'Search for chemicals by InChI or InChI key',
          inputSchema: {
            type: 'object',
            properties: {
              inchi: { type: 'string', description: 'InChI string or InChI key' },
              limit: { type: 'number', description: 'Number of results to return (1-1000, default: 25)', minimum: 1, maximum: 1000 },
            },
            required: ['inchi'],
          },
        },
        // Structure & Visualization (2 tools)
        {
          name: 'get_chemical_image',
          description: 'Generate chemical structure image from SMILES or other structure notation',
          inputSchema: {
            type: 'object',
            properties: {
              structure: { type: 'string', description: 'SMILES string or other structure notation' },
              height: { type: 'number', description: 'Image height in pixels (default: 200)', minimum: 50, maximum: 1000 },
              width: { type: 'number', description: 'Image width in pixels (default: 200)', minimum: 50, maximum: 1000 },
            },
            required: ['structure'],
          },
        },
        {
          name: 'get_chemical_properties',
          description: 'Get molecular properties and descriptors for a chemical by ID',
          inputSchema: {
            type: 'object',
            properties: {
              chemical_id: { type: 'string', description: 'SureChEMBL chemical ID' },
            },
            required: ['chemical_id'],
          },
        },
        // Data Export & Analysis (2 tools)
        {
          name: 'export_chemicals',
          description: 'Bulk export chemical data in CSV or XML format',
          inputSchema: {
            type: 'object',
            properties: {
              chemical_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'Array of SureChEMBL chemical IDs (1-100)',
                minItems: 1,
                maxItems: 100
              },
              output_type: {
                type: 'string',
                enum: ['csv', 'xml'],
                description: 'Export format (default: csv)'
              },
              kind: {
                type: 'string',
                enum: ['cid', 'smiles'],
                description: 'ID type for export (default: cid)'
              },
            },
            required: ['chemical_ids'],
          },
        },
        {
          name: 'analyze_patent_chemistry',
          description: 'Analyze chemical content and annotations in a patent document',
          inputSchema: {
            type: 'object',
            properties: {
              document_id: { type: 'string', description: 'Patent document ID to analyze' },
            },
            required: ['document_id'],
          },
        },
        // Advanced Analysis Tools (3 new tools)
        {
          name: 'get_chemical_frequency',
          description: 'Get frequency statistics for chemicals across the patent database',
          inputSchema: {
            type: 'object',
            properties: {
              chemical_id: { type: 'string', description: 'SureChEMBL chemical ID' },
            },
            required: ['chemical_id'],
          },
        },
        {
          name: 'search_similar_structures',
          description: 'Find structurally similar chemicals using similarity search',
          inputSchema: {
            type: 'object',
            properties: {
              reference_id: { type: 'string', description: 'Reference chemical ID for similarity search' },
              threshold: { type: 'number', description: 'Similarity threshold (0.0-1.0, default: 0.7)', minimum: 0.0, maximum: 1.0 },
              limit: { type: 'number', description: 'Number of results to return (1-100, default: 25)', minimum: 1, maximum: 100 },
            },
            required: ['reference_id'],
          },
        },
        {
          name: 'get_patent_statistics',
          description: 'Get statistical overview of chemical content in patents',
          inputSchema: {
            type: 'object',
            properties: {
              document_id: { type: 'string', description: 'Patent document ID for statistics' },
              include_annotations: { type: 'boolean', description: 'Include detailed annotation statistics (default: true)' },
            },
            required: ['document_id'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          // Document & Patent Search
          case 'search_patents':
            return await this.handleSearchPatents(args);
          case 'get_document_content':
            return await this.handleGetDocumentContent(args);
          case 'get_patent_family':
            return await this.handleGetPatentFamily(args);
          case 'search_by_patent_number':
            return await this.handleSearchByPatentNumber(args);
          // Chemical Search & Retrieval
          case 'search_chemicals_by_name':
            return await this.handleSearchChemicalsByName(args);
          case 'get_chemical_by_id':
            return await this.handleGetChemicalById(args);
          case 'search_by_smiles':
            return await this.handleSearchBySmiles(args);
          case 'search_by_inchi':
            return await this.handleSearchByInchi(args);
          // Structure & Visualization
          case 'get_chemical_image':
            return await this.handleGetChemicalImage(args);
          case 'get_chemical_properties':
            return await this.handleGetChemicalProperties(args);
          // Data Export & Analysis
          case 'export_chemicals':
            return await this.handleExportChemicals(args);
          case 'analyze_patent_chemistry':
            return await this.handleAnalyzePatentChemistry(args);
          // Advanced Analysis Tools
          case 'get_chemical_frequency':
            return await this.handleGetChemicalFrequency(args);
          case 'search_similar_structures':
            return await this.handleSearchSimilarStructures(args);
          case 'get_patent_statistics':
            return await this.handleGetPatentStatistics(args);
          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${name}`
            );
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error executing tool ${name}: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  // Document & Patent Search handlers
  private async handleSearchPatents(args: any) {
    if (!isValidSearchArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid search arguments');
    }

    try {
      // SureChEMBL doesn't have a direct patent search endpoint, so we'll search chemicals and return patent context
      const response = await this.apiClient.get(`/chemical/name/${encodeURIComponent(args.query)}`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              query: args.query,
              message: 'Patent search via chemical name lookup',
              results: response.data
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to search patents: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private async handleGetDocumentContent(args: any) {
    if (!isValidDocumentArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid document arguments');
    }

    try {
      const response = await this.apiClient.get(`/document/${args.document_id}/contents`);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response.data, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get document content: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private async handleGetPatentFamily(args: any) {
    if (!isValidIdArgs({ id: args.patent_id })) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid patent ID');
    }

    try {
      const response = await this.apiClient.get(`/document/${args.patent_id}/family/members`);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response.data, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get patent family: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private async handleSearchByPatentNumber(args: any) {
    if (!args || typeof args.patent_number !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid patent number');
    }

    try {
      // Try to get document content directly
      const response = await this.apiClient.get(`/document/${args.patent_number}/contents`);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              patent_number: args.patent_number,
              document: response.data
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to find patent: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  // Chemical Search & Retrieval handlers
  private async handleSearchChemicalsByName(args: any) {
    if (!args || typeof args.name !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid chemical name');
    }

    try {
      const response = await this.apiClient.get(`/chemical/name/${encodeURIComponent(args.name)}`);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response.data, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to search chemicals: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private async handleGetChemicalById(args: any) {
    if (!args || typeof args.chemical_id !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid chemical ID');
    }

    try {
      const response = await this.apiClient.get(`/chemical/id/${args.chemical_id}`);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response.data, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get chemical: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private async handleSearchBySmiles(args: any) {
    if (!args || typeof args.smiles !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid SMILES string');
    }

    try {
      // SureChEMBL doesn't have direct SMILES search, so we'll return a helpful message
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              message: 'SMILES search not directly supported by SureChEMBL API',
              smiles: args.smiles,
              suggestion: 'Try converting SMILES to chemical name or use structure-based search tools'
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to search by SMILES: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private async handleSearchByInchi(args: any) {
    if (!args || typeof args.inchi !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid InChI string');
    }

    try {
      // SureChEMBL doesn't have direct InChI search, so we'll return a helpful message
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              message: 'InChI search not directly supported by SureChEMBL API',
              inchi: args.inchi,
              suggestion: 'Try converting InChI to chemical name or use chemical ID lookup'
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to search by InChI: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  // Structure & Visualization handlers
  private async handleGetChemicalImage(args: any) {
    if (!isValidImageArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid image arguments');
    }

    try {
      const height = args.height || 200;
      const width = args.width || 200;

      const response = await this.apiClient.get('/service/chemical/image', {
        params: {
          structure: args.structure,
          height: height,
          width: width
        },
        responseType: 'arraybuffer'
      });

      // Convert binary data to base64 for JSON response
      const base64Image = Buffer.from(response.data).toString('base64');

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              structure: args.structure,
              image_data: `data:image/png;base64,${base64Image}`,
              dimensions: { width, height },
              message: 'Chemical structure image generated successfully'
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to generate chemical image: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private async handleGetChemicalProperties(args: any) {
    if (!args || typeof args.chemical_id !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid chemical ID');
    }

    try {
      const response = await this.apiClient.get(`/chemical/id/${args.chemical_id}`);

      // Extract and format properties
      const chemical = response.data.data?.[0];
      if (!chemical) {
        throw new Error('Chemical not found');
      }

      const properties = {
        chemical_id: chemical.chemical_id,
        name: chemical.name,
        molecular_weight: chemical.mol_weight,
        smiles: chemical.smiles,
        inchi: chemical.inchi,
        inchi_key: chemical.inchi_key,
        is_element: chemical.is_element === '1',
        global_frequency: chemical.global_frequency,
        structural_alerts: chemical.mchem_struct_alert === '1',
        // Additional computed properties if available
        log_p: chemical.log_p,
        donor_count: chemical.donor_count,
        acceptor_count: chemical.accept_count,
        ring_count: chemical.ring_count,
        rotatable_bonds: chemical.rotatable_bond_count
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              chemical_id: args.chemical_id,
              properties: properties
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get chemical properties: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  // Data Export & Analysis handlers
  private async handleExportChemicals(args: any) {
    if (!isValidExportArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid export arguments');
    }

    try {
      const chemIDs = args.chemical_ids.join(',');
      const outputType = args.output_type || 'csv';
      const kind = args.kind || 'cid';

      const response = await this.apiClient.get('/export/chemistry', {
        params: {
          chemIDs: chemIDs,
          output_type: outputType,
          kind: kind
        },
        responseType: 'arraybuffer'
      });

      // Convert binary data to base64 for JSON response
      const base64Data = Buffer.from(response.data).toString('base64');

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              chemical_ids: args.chemical_ids,
              output_type: outputType,
              kind: kind,
              export_data: `data:application/zip;base64,${base64Data}`,
              message: `Successfully exported ${args.chemical_ids.length} chemicals in ${outputType} format`
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to export chemicals: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private async handleAnalyzePatentChemistry(args: any) {
    if (!isValidDocumentArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid document arguments');
    }

    try {
      const response = await this.apiClient.get(`/document/${args.document_id}/contents`);
      const document = response.data.data;

      if (!document) {
        throw new Error('Document not found');
      }

      // Extract chemical annotations from abstracts and descriptions
      const chemicalAnnotations: any[] = [];

      // Process abstracts
      if (document.contents?.patentDocument?.abstracts) {
        document.contents.patentDocument.abstracts.forEach((abstract: any) => {
          if (abstract.section?.annotations) {
            abstract.section.annotations.forEach((annotation: any) => {
              chemicalAnnotations.push({
                source: 'abstract',
                language: abstract.lang,
                annotation: annotation
              });
            });
          }
        });
      }

      // Process descriptions
      if (document.contents?.patentDocument?.descriptions) {
        document.contents.patentDocument.descriptions.forEach((description: any) => {
          if (description.section?.annotations) {
            description.section.annotations.forEach((annotation: any) => {
              chemicalAnnotations.push({
                source: 'description',
                language: description.lang,
                annotation: annotation
              });
            });
          }
        });
      }

      // Analyze chemical content
      const analysis = {
        document_id: args.document_id,
        total_chemical_annotations: chemicalAnnotations.length,
        unique_chemicals: [...new Set(chemicalAnnotations.map(a => a.annotation.name))],
        annotation_categories: [...new Set(chemicalAnnotations.map(a => a.annotation.category))],
        chemical_annotations: chemicalAnnotations,
        summary: {
          has_chemical_content: chemicalAnnotations.length > 0,
          languages: [...new Set(chemicalAnnotations.map(a => a.language))],
          sources: [...new Set(chemicalAnnotations.map(a => a.source))]
        }
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(analysis, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to analyze patent chemistry: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  // Advanced Analysis Tools handlers
  private async handleGetChemicalFrequency(args: any) {
    if (!args || typeof args.chemical_id !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid chemical ID');
    }

    try {
      const response = await this.apiClient.get(`/chemical/id/${args.chemical_id}`);
      const chemical = response.data.data?.[0];

      if (!chemical) {
        throw new Error('Chemical not found');
      }

      const frequencyStats = {
        chemical_id: args.chemical_id,
        name: chemical.name,
        global_frequency: chemical.global_frequency || 0,
        frequency_analysis: {
          total_occurrences: chemical.global_frequency || 0,
          frequency_category: this.categorizeFrequency(chemical.global_frequency || 0),
          rarity_score: this.calculateRarityScore(chemical.global_frequency || 0)
        },
        chemical_info: {
          smiles: chemical.smiles,
          molecular_weight: chemical.mol_weight,
          inchi_key: chemical.inchi_key
        }
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(frequencyStats, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get chemical frequency: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private async handleSearchSimilarStructures(args: any) {
    if (!args || typeof args.reference_id !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid reference chemical ID');
    }

    try {
      // Get the reference chemical first
      const refResponse = await this.apiClient.get(`/chemical/id/${args.reference_id}`);
      const refChemical = refResponse.data.data?.[0];

      if (!refChemical) {
        throw new Error('Reference chemical not found');
      }

      // Since SureChEMBL doesn't have direct similarity search, we'll provide a mock implementation
      // that explains the limitation and suggests alternatives
      const similarityResult = {
        reference_chemical: {
          id: args.reference_id,
          name: refChemical.name,
          smiles: refChemical.smiles,
          molecular_weight: refChemical.mol_weight
        },
        search_parameters: {
          threshold: args.threshold || 0.7,
          limit: args.limit || 25
        },
        message: 'Direct similarity search not available in SureChEMBL API',
        suggestions: [
          'Use chemical name variations to find related compounds',
          'Search by molecular weight ranges',
          'Use external cheminformatics tools for similarity search',
          'Try searching by chemical class or functional groups'
        ],
        alternative_searches: {
          by_name_fragments: `Try searching for fragments of "${refChemical.name}"`,
          by_molecular_weight: `Search for compounds with molecular weight around ${refChemical.mol_weight}`,
          by_chemical_class: 'Search for compounds in the same chemical class'
        }
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(similarityResult, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to search similar structures: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private async handleGetPatentStatistics(args: any) {
    if (!isValidDocumentArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid document arguments');
    }

    try {
      const response = await this.apiClient.get(`/document/${args.document_id}/contents`);
      const document = response.data.data;

      if (!document) {
        throw new Error('Document not found');
      }

      const includeAnnotations = args.include_annotations !== false;

      // Extract basic document information
      const docInfo = document.contents?.patentDocument?.bibliographicData;
      const abstracts = document.contents?.patentDocument?.abstracts || [];
      const descriptions = document.contents?.patentDocument?.descriptions || [];

      // Collect all chemical annotations
      const allAnnotations: any[] = [];

      abstracts.forEach((abstract: any) => {
        if (abstract.section?.annotations) {
          abstract.section.annotations.forEach((annotation: any) => {
            allAnnotations.push({
              ...annotation,
              source: 'abstract',
              language: abstract.lang
            });
          });
        }
      });

      descriptions.forEach((description: any) => {
        if (description.section?.annotations) {
          description.section.annotations.forEach((annotation: any) => {
            allAnnotations.push({
              ...annotation,
              source: 'description',
              language: description.lang
            });
          });
        }
      });

      // Calculate statistics
      const chemicalAnnotations = allAnnotations.filter(a => a.category === 'chemical');
      const uniqueChemicals = [...new Set(chemicalAnnotations.map(a => a.name))];
      const chemicalFrequencies = chemicalAnnotations.reduce((acc: any, annotation: any) => {
        acc[annotation.name] = (acc[annotation.name] || 0) + 1;
        return acc;
      }, {});

      const statistics = {
        document_id: args.document_id,
        document_info: {
          title: docInfo?.inventionTitles?.find((t: any) => t.lang === 'EN')?.title || 'N/A',
          publication_number: docInfo?.publicationReference?.[0]?.ucid || 'N/A',
          publication_date: docInfo?.publicationReference?.[0]?.documentId?.[0]?.date || 'N/A'
        },
        content_statistics: {
          total_sections: abstracts.length + descriptions.length,
          abstract_sections: abstracts.length,
          description_sections: descriptions.length,
          languages: [...new Set([...abstracts, ...descriptions].map((s: any) => s.lang))]
        },
        chemical_statistics: {
          total_chemical_annotations: chemicalAnnotations.length,
          unique_chemicals_count: uniqueChemicals.length,
          most_frequent_chemicals: Object.entries(chemicalFrequencies)
            .sort(([,a], [,b]) => (b as number) - (a as number))
            .slice(0, 10)
            .map(([name, count]) => ({ name, count })),
          annotation_sources: {
            abstract: chemicalAnnotations.filter(a => a.source === 'abstract').length,
            description: chemicalAnnotations.filter(a => a.source === 'description').length
          }
        },
        annotation_categories: {
          chemical: chemicalAnnotations.length,
          other: allAnnotations.length - chemicalAnnotations.length,
          total: allAnnotations.length
        }
      };

      if (includeAnnotations) {
        (statistics as any).detailed_annotations = {
          chemical_annotations: chemicalAnnotations,
          unique_chemicals: uniqueChemicals,
          chemical_frequencies: chemicalFrequencies
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(statistics, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get patent statistics: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  // Helper methods
  private categorizeFrequency(frequency: number): string {
    if (frequency === 0) return 'Not found';
    if (frequency === 1) return 'Unique';
    if (frequency <= 10) return 'Very rare';
    if (frequency <= 100) return 'Rare';
    if (frequency <= 1000) return 'Uncommon';
    if (frequency <= 10000) return 'Common';
    return 'Very common';
  }

  private calculateRarityScore(frequency: number): number {
    if (frequency === 0) return 0;
    if (frequency === 1) return 1.0;
    // Logarithmic scale for rarity (higher frequency = lower rarity)
    return Math.max(0, 1 - Math.log10(frequency) / 6);
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('SureChEMBL MCP server running on stdio');
  }
}

const server = new SureChEMBLServer();
server.run().catch(console.error);
