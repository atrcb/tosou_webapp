import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Boxes, RefreshCcw, Rotate3D, ScanSearch, Upload} from 'lucide-react';
import occtImport from 'occt-import-js';
import occtWasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';
import * as THREE from 'three';
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js';
import {AMFLoader} from 'three/examples/jsm/loaders/AMFLoader.js';
import {ColladaLoader} from 'three/examples/jsm/loaders/ColladaLoader.js';
import {FBXLoader} from 'three/examples/jsm/loaders/FBXLoader.js';
import {GCodeLoader} from 'three/examples/jsm/loaders/GCodeLoader.js';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {MTLLoader} from 'three/examples/jsm/loaders/MTLLoader.js';
import {OBJLoader} from 'three/examples/jsm/loaders/OBJLoader.js';
import {PCDLoader} from 'three/examples/jsm/loaders/PCDLoader.js';
import {PLYLoader} from 'three/examples/jsm/loaders/PLYLoader.js';
import {STLLoader} from 'three/examples/jsm/loaders/STLLoader.js';
import {TDSLoader} from 'three/examples/jsm/loaders/TDSLoader.js';
import {ThreeMFLoader} from 'three/examples/jsm/loaders/3MFLoader.js';
import {USDLoader} from 'three/examples/jsm/loaders/USDLoader.js';
import {VOXLoader, buildMesh as buildVoxMesh} from 'three/examples/jsm/loaders/VOXLoader.js';
import {VRMLLoader} from 'three/examples/jsm/loaders/VRMLLoader.js';
import {VTKLoader} from 'three/examples/jsm/loaders/VTKLoader.js';
import {XYZLoader} from 'three/examples/jsm/loaders/XYZLoader.js';

type Language = 'en' | 'ja';
type ViewerMode = 'assembled' | 'exploded';
type LoadState = 'loading' | 'converting' | 'ready' | 'uploaded' | 'demo' | 'fallback' | 'error';
type ModelSourceType = 'catalog' | 'upload';

export type ModelCatalogItem = {
  id: string;
  name: string;
  modelUrl: string;
  description?: string;
  fileUrls?: Record<string, string>;
  files?: File[];
  rootFileName?: string;
  source?: ModelSourceType;
};

type ProductViewerProps = {
  language: Language;
  reducedMotion?: boolean;
};

type PartRecord = {
  object: THREE.Object3D;
  basePosition: THREE.Vector3;
  direction: THREE.Vector3;
  distance: number;
  current: number;
};

type OcctMesh = {
  name?: string;
  color?: [number, number, number];
  brep_faces?: Array<{
    first: number;
    last: number;
    color?: [number, number, number] | null;
  }>;
  attributes: {
    position: {array: number[]};
    normal?: {array: number[]};
  };
  index: {array: number[]};
};

type OcctImportResult = {
  success: boolean;
  error?: string;
  meshes?: OcctMesh[];
};

type ConvertedModelResponse = {
  convertedFrom?: string;
  modelUrl: string;
  name: string;
  rootFileName?: string;
};

const DEFAULT_CATALOG: ModelCatalogItem[] = [
  {
    id: 'demo-assembly',
    name: 'Demo Assembly',
    modelUrl: '',
    description: 'Generated fallback product assembly.',
  },
];

const CATALOG_URL = '/models/catalog.json';
const CAMERA_DIRECTION = new THREE.Vector3(5.5, 3.8, 6.4).normalize();
const MODEL_EXTENSIONS = [
  'glb',
  'gltf',
  'obj',
  'stl',
  'ply',
  'fbx',
  'dae',
  '3mf',
  'amf',
  '3ds',
  'wrl',
  'vrml',
  'vtk',
  'vtp',
  'usd',
  'usdz',
  'vox',
  'gcode',
  'pcd',
  'xyz',
  'step',
  'stp',
  'iges',
  'igs',
  'brep',
];
const MODEL_EXTENSION_SET = new Set(MODEL_EXTENSIONS);
const AUXILIARY_EXTENSIONS = [
  'bin',
  'mtl',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'bmp',
  'tga',
  'dds',
  'ktx',
  'ktx2',
  'hdr',
  'exr',
];
const CAD_CONVERSION_EXTENSIONS = new Set([
  'easm',
  'eprt',
  '3dm',
  'sldprt',
  'sldasm',
  'prt',
  'asm',
  'x_t',
  'x_b',
  'catpart',
  'catproduct',
  'ipt',
  'iam',
  'f3d',
]);
const ACCEPTED_UPLOAD_TYPES = [...MODEL_EXTENSIONS, ...AUXILIARY_EXTENSIONS]
  .concat(Array.from(CAD_CONVERSION_EXTENSIONS))
  .map((extension) => `.${extension}`)
  .join(',');

const localize = (language: Language, en: string, ja: string) => (language === 'ja' ? ja : en);

const isMesh = (object: THREE.Object3D): object is THREE.Mesh =>
  (object as THREE.Mesh).isMesh === true;

const isTextureLike = (value: unknown): value is THREE.Texture =>
  Boolean(value && typeof value === 'object' && (value as THREE.Texture).isTexture === true);

const getExtension = (name: string) => {
  const cleanName = name.split('?')[0].split('#')[0].trim().toLowerCase();
  const dotIndex = cleanName.lastIndexOf('.');
  return dotIndex >= 0 ? cleanName.slice(dotIndex + 1) : '';
};

const getBaseName = (name: string) => {
  const cleanName = name.split('?')[0].split('#')[0].replace(/\\/g, '/');
  return cleanName.slice(cleanName.lastIndexOf('/') + 1);
};

const stripExtension = (name: string) => {
  const baseName = getBaseName(name);
  const dotIndex = baseName.lastIndexOf('.');
  return dotIndex >= 0 ? baseName.slice(0, dotIndex) : baseName;
};

const getBasePath = (url: string) => {
  const queryIndex = url.search(/[?#]/);
  const pathPart = queryIndex >= 0 ? url.slice(0, queryIndex) : url;
  const slashIndex = pathPart.lastIndexOf('/');
  return slashIndex >= 0 ? pathPart.slice(0, slashIndex + 1) : '';
};

const normalizeResourceKey = (name: string) =>
  decodeURIComponent(name.split('?')[0].split('#')[0].replace(/\\/g, '/')).toLowerCase();

const getFileRelativePath = (file: File) =>
  ((file as File & {webkitRelativePath?: string}).webkitRelativePath || file.name).replace(/\\/g, '/');

const findRootModelFile = (files: File[]) =>
  files.find((file) => MODEL_EXTENSION_SET.has(getExtension(file.name))) ??
  files.find((file) => CAD_CONVERSION_EXTENSIONS.has(getExtension(file.name))) ??
  null;

const readApiError = async (response: Response) => {
  try {
    const data = (await response.json()) as {error?: unknown};
    if (typeof data.error === 'string' && data.error.trim()) {
      return data.error.trim();
    }
  } catch {
    // Fall back to the status text below.
  }
  return response.statusText || 'Request failed';
};

const convertUploadedModel = async (files: File[], rootFile: File): Promise<ConvertedModelResponse> => {
  const formData = new FormData();
  files.forEach((file) => formData.append('files', file, getFileRelativePath(file)));
  formData.append('rootFileName', getFileRelativePath(rootFile));

  const response = await fetch('/api/models/convert', {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('Model conversion endpoint was not found. Restart the backend so SLDPRT/EASM conversion is available.');
    }
    throw new Error(await readApiError(response));
  }

  const data = (await response.json()) as Partial<ConvertedModelResponse>;
  if (typeof data.modelUrl !== 'string' || typeof data.name !== 'string') {
    throw new Error('Model converter returned an invalid response.');
  }

  return {
    convertedFrom: typeof data.convertedFrom === 'string' ? data.convertedFrom : undefined,
    modelUrl: data.modelUrl,
    name: data.name,
    rootFileName: typeof data.rootFileName === 'string' ? data.rootFileName : undefined,
  };
};

const normalizeCatalog = (input: unknown): ModelCatalogItem[] => {
  if (!Array.isArray(input)) {
    return DEFAULT_CATALOG;
  }

  const catalog: ModelCatalogItem[] = [];
  input.forEach((item) => {
    if (!item || typeof item !== 'object') {
      return;
    }
    const candidate = item as Partial<ModelCatalogItem>;
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    const modelUrl = typeof candidate.modelUrl === 'string' ? candidate.modelUrl.trim() : '';
    const description = typeof candidate.description === 'string' ? candidate.description.trim() : undefined;
    if (!id || !name) {
      return;
    }

    catalog.push({id, name, modelUrl, description});
  });

  return catalog.length ? catalog : DEFAULT_CATALOG;
};

const disposeMaterial = (material: THREE.Material) => {
  Object.values(material).forEach((value) => {
    if (isTextureLike(value)) {
      value.dispose();
    }
  });
  material.dispose();
};

const getBufferGeometry = (object: THREE.Object3D) => {
  const geometry = (object as THREE.Object3D & {geometry?: THREE.BufferGeometry}).geometry;
  return geometry?.isBufferGeometry ? geometry : null;
};

const getObjectMaterials = (object: THREE.Object3D) => {
  const material = (object as THREE.Object3D & {material?: THREE.Material | THREE.Material[]}).material;
  if (!material) {
    return [];
  }
  return Array.isArray(material) ? material : [material];
};

const disposeObject = (object: THREE.Object3D) => {
  object.traverse((child) => {
    const geometry = getBufferGeometry(child);
    if (geometry) {
      geometry.dispose();
    }
    getObjectMaterials(child).forEach(disposeMaterial);
  });
};

const clearGroup = (group: THREE.Group) => {
  group.children.forEach(disposeObject);
  group.clear();
};

const prepareModel = (object: THREE.Object3D) => {
  object.traverse((child) => {
    if (!getBufferGeometry(child)) {
      return;
    }

    if (isMesh(child)) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
    child.frustumCulled = false;
    getObjectMaterials(child).forEach((material) => {
      material.side = THREE.FrontSide;
      material.needsUpdate = true;
    });
  });
};

const normalizeAssembly = (assembly: THREE.Group) => {
  assembly.updateMatrixWorld(true);
  const initialBox = new THREE.Box3().setFromObject(assembly);
  if (initialBox.isEmpty()) {
    return;
  }

  const center = initialBox.getCenter(new THREE.Vector3());
  const size = initialBox.getSize(new THREE.Vector3());
  const largestAxis = Math.max(size.x, size.y, size.z, 1);
  const scale = 3.4 / largestAxis;

  assembly.scale.setScalar(scale);
  assembly.position.copy(center).multiplyScalar(-scale);
  assembly.updateMatrixWorld(true);

  const fittedBox = new THREE.Box3().setFromObject(assembly);
  if (!fittedBox.isEmpty()) {
    assembly.position.y -= fittedBox.min.y;
  }
  assembly.updateMatrixWorld(true);
};

const deterministicDirection = (index: number) => {
  const angle = index * 2.399963229728653;
  return new THREE.Vector3(Math.cos(angle), 0.45 + (index % 3) * 0.22, Math.sin(angle)).normalize();
};

const getLocalDirection = (object: THREE.Object3D, worldDirection: THREE.Vector3) => {
  if (!object.parent) {
    return worldDirection.clone().normalize();
  }

  const origin = object.getWorldPosition(new THREE.Vector3());
  const target = origin.clone().add(worldDirection);
  const localOrigin = object.parent.worldToLocal(origin.clone());
  const localTarget = object.parent.worldToLocal(target.clone());
  const localDirection = localTarget.sub(localOrigin);
  if (localDirection.lengthSq() < 0.0001) {
    return worldDirection.clone().normalize();
  }
  return localDirection.normalize();
};

const buildPartRecords = (assembly: THREE.Group): PartRecord[] => {
  assembly.updateMatrixWorld(true);

  const renderableObjects: THREE.Object3D[] = [];
  assembly.traverse((child) => {
    if (getBufferGeometry(child)) {
      renderableObjects.push(child);
    }
  });

  const assemblyBox = new THREE.Box3().setFromObject(assembly);
  const assemblyCenter = assemblyBox.getCenter(new THREE.Vector3());
  const assemblySize = assemblyBox.getSize(new THREE.Vector3());
  const maxDimension = Math.max(assemblySize.x, assemblySize.y, assemblySize.z, 1);
  const explodeDistance = Math.max(1.1, maxDimension * 0.48);

  return renderableObjects.map((object, index) => {
    const partBox = new THREE.Box3().setFromObject(object);
    const partCenter = partBox.getCenter(new THREE.Vector3());
    const worldDirection = partCenter.sub(assemblyCenter);
    if (worldDirection.lengthSq() < 0.0001) {
      worldDirection.copy(deterministicDirection(index));
    } else {
      worldDirection.normalize();
    }

    return {
      object,
      basePosition: object.position.clone(),
      direction: getLocalDirection(object, worldDirection),
      distance: explodeDistance,
      current: 0,
    };
  });
};

const applyExplosion = (parts: PartRecord[], target: number, immediate = false) => {
  parts.forEach((part) => {
    part.current = immediate ? target : part.current + (target - part.current) * 0.14;
    if (Math.abs(target - part.current) < 0.002) {
      part.current = target;
    }
    part.object.position.copy(part.basePosition).addScaledVector(part.direction, part.distance * part.current);
  });
};

const createDemoAssembly = () => {
  const group = new THREE.Group();
  group.name = 'Generated product assembly';

  const metal = new THREE.MeshStandardMaterial({color: '#94a3b8', metalness: 0.54, roughness: 0.34});
  const darkMetal = new THREE.MeshStandardMaterial({color: '#263241', metalness: 0.62, roughness: 0.3});
  const cover = new THREE.MeshStandardMaterial({color: '#0ea5e9', metalness: 0.2, roughness: 0.38});
  const accent = new THREE.MeshStandardMaterial({color: '#f59e0b', metalness: 0.16, roughness: 0.42});
  const rubber = new THREE.MeshStandardMaterial({color: '#111827', metalness: 0.05, roughness: 0.74});
  const lens = new THREE.MeshPhysicalMaterial({
    color: '#22d3ee',
    metalness: 0,
    roughness: 0.08,
    transmission: 0.28,
    transparent: true,
    opacity: 0.72,
  });

  const addPart = (
    name: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    position: [number, number, number],
    rotation: [number, number, number] = [0, 0, 0],
  ) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.position.set(...position);
    mesh.rotation.set(...rotation);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  };

  addPart('main chassis', new THREE.BoxGeometry(2.8, 0.28, 1.55), darkMetal, [0, 0.12, 0]);
  addPart('top cover', new THREE.BoxGeometry(2.35, 0.2, 1.18), cover, [0, 0.42, 0]);
  addPart('front face plate', new THREE.BoxGeometry(1.42, 0.78, 0.16), metal, [0, 0.56, 0.84]);
  addPart('rear service plate', new THREE.BoxGeometry(1.72, 0.6, 0.12), metal, [0, 0.48, -0.83]);
  addPart('left rail', new THREE.BoxGeometry(0.2, 0.3, 1.86), metal, [-1.42, 0.34, 0]);
  addPart('right rail', new THREE.BoxGeometry(0.2, 0.3, 1.86), metal, [1.42, 0.34, 0]);
  addPart('control knob', new THREE.CylinderGeometry(0.2, 0.2, 0.18, 32), accent, [-0.46, 0.6, 0.96], [Math.PI / 2, 0, 0]);
  addPart('status lens', new THREE.CylinderGeometry(0.24, 0.24, 0.16, 32), lens, [0.44, 0.6, 0.96], [Math.PI / 2, 0, 0]);
  addPart('front gasket', new THREE.TorusGeometry(0.42, 0.035, 12, 48), rubber, [0.44, 0.6, 1.05], [0, 0, 0]);
  addPart('left fastener', new THREE.CylinderGeometry(0.08, 0.08, 0.12, 24), accent, [-1.02, 0.58, 0.92], [Math.PI / 2, 0, 0]);
  addPart('right fastener', new THREE.CylinderGeometry(0.08, 0.08, 0.12, 24), accent, [1.02, 0.58, 0.92], [Math.PI / 2, 0, 0]);
  addPart('rear connector', new THREE.CylinderGeometry(0.18, 0.18, 0.3, 32), rubber, [0, 0.48, -1.02], [Math.PI / 2, 0, 0]);

  return group;
};

const fitCameraToRoot = (
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  root: THREE.Object3D,
) => {
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) {
    camera.position.set(5, 3.5, 6);
    controls.target.set(0, 0.45, 0);
    controls.update();
    return;
  }

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() * 0.5, 1);
  const verticalFov = THREE.MathUtils.degToRad(camera.fov);
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
  const limitingFov = Math.max(0.1, Math.min(verticalFov, horizontalFov));
  const distance = Math.max(4, (radius / Math.sin(limitingFov / 2)) * 1.18);

  camera.near = Math.max(0.01, distance / 100);
  camera.far = distance * 80;
  camera.position.copy(center).addScaledVector(CAMERA_DIRECTION, distance);
  camera.updateProjectionMatrix();

  controls.target.copy(center);
  controls.minDistance = Math.max(0.8, distance * 0.22);
  controls.maxDistance = distance * 4;
  controls.update();
};

const createSourceLoadingManager = (source: ModelCatalogItem) => {
  const manager = new THREE.LoadingManager();
  const fileUrls = source.fileUrls;
  if (!fileUrls) {
    return manager;
  }

  manager.setURLModifier((url) => {
    const normalized = normalizeResourceKey(url);
    const basename = getBaseName(normalized);
    return fileUrls[normalized] ?? fileUrls[basename] ?? url;
  });

  return manager;
};

const getSourceRootName = (source: ModelCatalogItem) => source.rootFileName || source.modelUrl || source.name;

const findSourceFile = (source: ModelCatalogItem, fileName: string) => {
  const files = source.files ?? [];
  const normalizedName = normalizeResourceKey(fileName);
  const normalizedBase = getBaseName(normalizedName);
  return (
    files.find((file) => normalizeResourceKey(getFileRelativePath(file)) === normalizedName) ??
    files.find((file) => normalizeResourceKey(file.name) === normalizedBase) ??
    null
  );
};

const readSourceAsArrayBuffer = async (source: ModelCatalogItem) => {
  const rootName = getSourceRootName(source);
  const rootFile = source.files ? findSourceFile(source, rootName) : null;
  if (rootFile) {
    return rootFile.arrayBuffer();
  }

  const response = await fetch(source.modelUrl);
  if (!response.ok) {
    throw new Error(`Could not load ${source.modelUrl}`);
  }
  return response.arrayBuffer();
};

const readSourceAsText = async (source: ModelCatalogItem) => {
  const rootName = getSourceRootName(source);
  const rootFile = source.files ? findSourceFile(source, rootName) : null;
  if (rootFile) {
    return rootFile.text();
  }

  const response = await fetch(source.modelUrl);
  if (!response.ok) {
    throw new Error(`Could not load ${source.modelUrl}`);
  }
  return response.text();
};

const createGeometryAssembly = (
  name: string,
  geometry: THREE.BufferGeometry,
  mode: 'mesh' | 'points' = 'mesh',
) => {
  const group = new THREE.Group();
  group.name = name;

  if (!geometry.getAttribute('normal') && mode === 'mesh') {
    geometry.computeVertexNormals();
  }

  if (mode === 'points') {
    const material = new THREE.PointsMaterial({
      color: '#38bdf8',
      size: 0.035,
      sizeAttenuation: true,
      vertexColors: Boolean(geometry.getAttribute('color')),
    });
    const points = new THREE.Points(geometry, material);
    points.name = name;
    group.add(points);
    return group;
  }

  const material = new THREE.MeshStandardMaterial({
    color: '#94a3b8',
    metalness: 0.22,
    roughness: 0.48,
    vertexColors: Boolean(geometry.getAttribute('color')),
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return group;
};

let occtPromise: ReturnType<typeof occtImport> | null = null;

const loadOcct = () => {
  if (!occtPromise) {
    occtPromise = occtImport({
      locateFile: (path) => (path.endsWith('.wasm') ? occtWasmUrl : path),
    });
  }
  return occtPromise;
};

const buildOcctMesh = (meshData: OcctMesh, fallbackName: string) => {
  const geometry = new THREE.BufferGeometry();
  geometry.name = meshData.name || fallbackName;
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(meshData.attributes.position.array, 3));
  if (meshData.attributes.normal) {
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(meshData.attributes.normal.array, 3));
  } else {
    geometry.computeVertexNormals();
  }
  geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(meshData.index.array), 1));

  const defaultMaterial = new THREE.MeshStandardMaterial({
    color: meshData.color ? new THREE.Color(meshData.color[0], meshData.color[1], meshData.color[2]) : new THREE.Color('#b7c2cf'),
    metalness: 0.16,
    roughness: 0.46,
  });
  const materials: THREE.Material[] = [defaultMaterial];

  if (meshData.brep_faces?.length) {
    meshData.brep_faces.forEach((face) => {
      const color = face.color
        ? new THREE.Color(face.color[0], face.color[1], face.color[2])
        : defaultMaterial.color;
      materials.push(
        new THREE.MeshStandardMaterial({
          color,
          metalness: 0.16,
          roughness: 0.46,
        }),
      );
    });

    const triangleCount = meshData.index.array.length / 3;
    let triangleIndex = 0;
    let faceIndex = 0;
    while (triangleIndex < triangleCount) {
      const firstIndex = triangleIndex;
      let lastIndex = triangleCount;
      let materialIndex = 0;
      const face = meshData.brep_faces[faceIndex];

      if (face && triangleIndex >= face.first) {
        lastIndex = face.last + 1;
        materialIndex = faceIndex + 1;
        faceIndex += 1;
      } else if (face) {
        lastIndex = face.first;
      }

      geometry.addGroup(firstIndex * 3, (lastIndex - firstIndex) * 3, materialIndex);
      triangleIndex = lastIndex;
    }
  }

  const mesh = new THREE.Mesh(geometry, materials.length > 1 ? materials : materials[0]);
  mesh.name = geometry.name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
};

const parseOcctAssembly = async (source: ModelCatalogItem, extension: string) => {
  const occt = await loadOcct();
  const content = new Uint8Array(await readSourceAsArrayBuffer(source));
  const params = {
    linearUnit: 'millimeter',
    linearDeflectionType: 'bounding_box_ratio',
    linearDeflection: 0.001,
    angularDeflection: 0.5,
  };
  const result = (
    extension === 'brep'
      ? occt.ReadBrepFile(content, params)
      : extension === 'iges' || extension === 'igs'
        ? occt.ReadIgesFile(content, params)
        : occt.ReadStepFile(content, params)
  ) as OcctImportResult;

  if (!result.success || !result.meshes?.length) {
    throw new Error(result.error || 'CAD file could not be converted to viewer geometry.');
  }

  const group = new THREE.Group();
  group.name = source.name;
  result.meshes.forEach((meshData, index) => {
    group.add(buildOcctMesh(meshData, `${source.name} mesh ${index + 1}`));
  });
  return group;
};

const wrapObjectAssembly = (name: string, object: THREE.Object3D) => {
  const group = new THREE.Group();
  group.name = name;
  group.add(object);
  return group;
};

const parseGltfAssembly = async (
  source: ModelCatalogItem,
  manager: THREE.LoadingManager,
  path: string,
) => {
  const extension = getExtension(getSourceRootName(source));
  const data = extension === 'gltf' ? await readSourceAsText(source) : await readSourceAsArrayBuffer(source);
  const loader = new GLTFLoader(manager);
  return new Promise<THREE.Group>((resolve, reject) => {
    loader.parse(
      data,
      path,
      (gltf) => resolve(wrapObjectAssembly(source.name, gltf.scene)),
      (error) => reject(error instanceof Error ? error : new Error('GLTF parse failed')),
    );
  });
};

const findObjMaterialFile = (source: ModelCatalogItem, objText: string) => {
  const mtllibMatch = objText.match(/^mtllib\s+(.+)$/im);
  const referencedName = mtllibMatch?.[1]?.trim();
  if (referencedName) {
    const referencedFile = findSourceFile(source, referencedName);
    if (referencedFile) {
      return referencedFile;
    }
  }

  const expectedBase = stripExtension(getSourceRootName(source)).toLowerCase();
  return (
    source.files?.find((file) => getExtension(file.name) === 'mtl' && stripExtension(file.name).toLowerCase() === expectedBase) ??
    null
  );
};

const parseObjAssembly = async (
  source: ModelCatalogItem,
  manager: THREE.LoadingManager,
) => {
  const objText = await readSourceAsText(source);
  const loader = new OBJLoader(manager);
  const materialFile = findObjMaterialFile(source, objText);

  if (materialFile) {
    const materialLoader = new MTLLoader(manager);
    const materialCreator = materialLoader.parse(await materialFile.text(), '');
    materialCreator.setManager(manager);
    materialCreator.preload();
    loader.setMaterials(materialCreator);
  }

  return loader.parse(objText);
};

const loadAssemblyFromSource = async (source: ModelCatalogItem) => {
  const extension = getExtension(getSourceRootName(source));
  const manager = createSourceLoadingManager(source);
  const path = source.source === 'upload' ? '' : getBasePath(source.modelUrl);

  if (!MODEL_EXTENSION_SET.has(extension)) {
    if (CAD_CONVERSION_EXTENSIONS.has(extension)) {
      throw new Error('This CAD format needs to be converted to GLB before viewing.');
    }
    throw new Error('Unsupported 3D file format.');
  }

  switch (extension) {
    case 'glb':
    case 'gltf':
      return parseGltfAssembly(source, manager, path);
    case 'obj':
      return parseObjAssembly(source, manager);
    case 'stl':
      return createGeometryAssembly(source.name, new STLLoader(manager).parse(await readSourceAsArrayBuffer(source)));
    case 'ply':
      return createGeometryAssembly(source.name, new PLYLoader(manager).parse(await readSourceAsArrayBuffer(source)));
    case 'fbx':
      return new FBXLoader(manager).parse(await readSourceAsArrayBuffer(source), path);
    case 'dae': {
      const collada = new ColladaLoader(manager).parse(await readSourceAsText(source), path);
      if (!collada?.scene) {
        throw new Error('Collada file did not contain a scene.');
      }
      return wrapObjectAssembly(source.name, collada.scene);
    }
    case '3mf':
      return new ThreeMFLoader(manager).parse(await readSourceAsArrayBuffer(source));
    case 'amf':
      return new AMFLoader(manager).parse(await readSourceAsArrayBuffer(source));
    case '3ds':
      return new TDSLoader(manager).parse(await readSourceAsArrayBuffer(source), path);
    case 'wrl':
    case 'vrml':
      return wrapObjectAssembly(source.name, new VRMLLoader(manager).parse(await readSourceAsText(source), path));
    case 'vtk':
    case 'vtp':
      return createGeometryAssembly(source.name, new VTKLoader(manager).parse(await readSourceAsArrayBuffer(source), path));
    case 'usd':
    case 'usdz':
      return new USDLoader(manager).parse(await readSourceAsArrayBuffer(source));
    case 'vox': {
      const result = new VOXLoader(manager).parse(await readSourceAsArrayBuffer(source));
      if (result.scene) {
        return wrapObjectAssembly(source.name, result.scene);
      }
      const group = new THREE.Group();
      group.name = source.name;
      result.chunks.forEach((chunk) => group.add(buildVoxMesh(chunk)));
      return group;
    }
    case 'gcode':
      return new GCodeLoader(manager).parse(await readSourceAsText(source));
    case 'pcd':
      return wrapObjectAssembly(source.name, new PCDLoader(manager).parse(await readSourceAsArrayBuffer(source)));
    case 'xyz': {
      const loader = new XYZLoader(manager);
      let parsedGeometry: THREE.BufferGeometry | null = null;
      loader.parse(await readSourceAsText(source), (geometry) => {
        parsedGeometry = geometry;
      });
      if (!parsedGeometry) {
        throw new Error('XYZ file did not contain geometry.');
      }
      return createGeometryAssembly(source.name, parsedGeometry, 'points');
    }
    case 'step':
    case 'stp':
    case 'iges':
    case 'igs':
    case 'brep':
      return parseOcctAssembly(source, extension);
    default:
      throw new Error('Unsupported 3D file format.');
  }
};

export default function ProductViewer({language, reducedMotion = false}: ProductViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const modelRootRef = useRef<THREE.Group | null>(null);
  const partsRef = useRef<PartRecord[]>([]);
  const modeRef = useRef<ViewerMode>('assembled');
  const explosionRef = useRef(0.85);
  const autoRotateRef = useRef(false);
  const resetCameraRef = useRef<() => void>(() => undefined);
  const uploadedUrlsRef = useRef<string[]>([]);

  const [catalog, setCatalog] = useState<ModelCatalogItem[]>(DEFAULT_CATALOG);
  const [uploadedSources, setUploadedSources] = useState<ModelCatalogItem[]>([]);
  const [selectedModelId, setSelectedModelId] = useState(DEFAULT_CATALOG[0].id);
  const [mode, setMode] = useState<ViewerMode>('assembled');
  const [explosion, setExplosion] = useState(0.85);
  const [autoRotate, setAutoRotate] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [statusMessage, setStatusMessage] = useState('');
  const [partCount, setPartCount] = useState(0);
  const [sceneReady, setSceneReady] = useState(false);

  const modelOptions = useMemo(
    () => [...uploadedSources, ...(catalog.length ? catalog : DEFAULT_CATALOG)],
    [catalog, uploadedSources],
  );

  const selectedItem = useMemo(
    () => modelOptions.find((item) => item.id === selectedModelId) ?? modelOptions[0] ?? DEFAULT_CATALOG[0],
    [modelOptions, selectedModelId],
  );

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    explosionRef.current = explosion;
  }, [explosion]);

  useEffect(() => {
    autoRotateRef.current = autoRotate;
  }, [autoRotate]);

  useEffect(
    () => () => {
      uploadedUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      uploadedUrlsRef.current = [];
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;

    const loadCatalog = async () => {
      try {
        const response = await fetch(CATALOG_URL, {cache: 'no-store'});
        const data = response.ok ? await response.json() : null;
        const normalized = normalizeCatalog(data);
        if (cancelled) {
          return;
        }
        setCatalog(normalized);
        setSelectedModelId((current) =>
          current.startsWith('upload-') || normalized.some((item) => item.id === current) ? current : normalized[0].id,
        );
      } catch {
        if (!cancelled) {
          setCatalog(DEFAULT_CATALOG);
          setSelectedModelId(DEFAULT_CATALOG[0].id);
        }
      }
    };

    void loadCatalog();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleUploadFiles = async (fileList: FileList | null) => {
    const files = Array.from(fileList ?? []);
    if (!files.length) {
      return;
    }

    const rootFile = findRootModelFile(files);
    if (!rootFile) {
      const firstExtension = getExtension(files[0]?.name ?? '');
      setLoadState('error');
      setStatusMessage(
        CAD_CONVERSION_EXTENSIONS.has(firstExtension)
          ? localize(language, 'Convert CAD files to GLB before viewing.', 'CAD ファイルは GLB に変換してから表示してください。')
          : localize(language, 'No supported 3D model file was selected.', '対応している 3D モデルファイルが選択されていません。'),
      );
      return;
    }

    const rootExtension = getExtension(rootFile.name);
    if (CAD_CONVERSION_EXTENSIONS.has(rootExtension)) {
      setLoadState('converting');
      setPartCount(0);
      setStatusMessage(
        localize(
          language,
          `Converting ${rootFile.name} to GLB before viewing...`,
          `${rootFile.name} を表示用 GLB に変換しています...`,
        ),
      );

      try {
        const converted = await convertUploadedModel(files, rootFile);
        const source: ModelCatalogItem = {
          id: `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: converted.name,
          modelUrl: converted.modelUrl,
          description: converted.convertedFrom ?? rootFile.name,
          rootFileName: converted.rootFileName ?? converted.name,
          source: 'upload',
        };

        setUploadedSources((current) => [source, ...current]);
        setSelectedModelId(source.id);
        setMode('assembled');
        setStatusMessage(localize(language, 'Converted model is loading...', '変換済みモデルを読み込み中...'));
        setLoadState('loading');
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : localize(language, 'Model conversion failed.', 'モデル変換に失敗しました。');
        setLoadState('error');
        setStatusMessage(message);
      }
      return;
    }

    const fileUrls: Record<string, string> = {};
    files.forEach((file) => {
      const objectUrl = URL.createObjectURL(file);
      uploadedUrlsRef.current.push(objectUrl);

      const relativePath = normalizeResourceKey(getFileRelativePath(file));
      const basename = getBaseName(relativePath);
      fileUrls[relativePath] = objectUrl;
      fileUrls[basename] = objectUrl;
    });

    const source: ModelCatalogItem = {
      id: `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: rootFile.name,
      modelUrl: fileUrls[normalizeResourceKey(getFileRelativePath(rootFile))] ?? fileUrls[normalizeResourceKey(rootFile.name)] ?? '',
      description: rootFile.name,
      files,
      fileUrls,
      rootFileName: getFileRelativePath(rootFile),
      source: 'upload',
    };

    setUploadedSources((current) => [source, ...current]);
    setSelectedModelId(source.id);
    setMode('assembled');
    setStatusMessage(localize(language, 'Loading uploaded model...', 'アップロードしたモデルを読み込み中...'));
    setLoadState('loading');
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    let animationFrame = 0;
    const scene = new THREE.Scene();
    scene.background = null;
    scene.fog = new THREE.Fog('#edf2f7', 7, 18);

    const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 120);
    camera.position.set(5, 3.5, 6);

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        preserveDrawingBuffer: true,
        powerPreference: 'high-performance',
      });
    } catch {
      setLoadState('error');
      setStatusMessage(localize(language, 'WebGL is unavailable in this browser.', 'このブラウザでは WebGL を利用できません。'));
      return;
    }

    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.04;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.domElement.setAttribute('data-product-viewer-canvas', 'true');
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = true;
    controls.autoRotateSpeed = 0.72;

    const modelRoot = new THREE.Group();
    modelRoot.name = 'Product viewer model root';
    scene.add(modelRoot);

    const ambient = new THREE.HemisphereLight('#e0f2fe', '#334155', 1.7);
    scene.add(ambient);

    const keyLight = new THREE.DirectionalLight('#ffffff', 3.2);
    keyLight.position.set(4, 7, 5);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.far = 24;
    keyLight.shadow.camera.left = -7;
    keyLight.shadow.camera.right = 7;
    keyLight.shadow.camera.top = 7;
    keyLight.shadow.camera.bottom = -7;
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight('#bae6fd', 1.25);
    fillLight.position.set(-5, 3, -4);
    scene.add(fillLight);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(4.4, 96),
      new THREE.ShadowMaterial({color: '#0f172a', opacity: 0.13}),
    );
    floor.name = 'viewer floor shadow';
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    const grid = new THREE.GridHelper(8, 16, '#94a3b8', '#cbd5e1');
    grid.name = 'viewer floor grid';
    grid.position.y = 0.004;
    const gridMaterial = Array.isArray(grid.material) ? grid.material[0] : grid.material;
    gridMaterial.opacity = 0.18;
    gridMaterial.transparent = true;
    scene.add(grid);

    const resizeRenderer = () => {
      const rect = host.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };

    const resizeObserver = new ResizeObserver(resizeRenderer);
    resizeObserver.observe(host);
    resizeRenderer();

    resetCameraRef.current = () => fitCameraToRoot(camera, controls, modelRoot);

    const animate = () => {
      animationFrame = window.requestAnimationFrame(animate);
      const targetExplosion = modeRef.current === 'exploded' ? explosionRef.current : 0;
      applyExplosion(partsRef.current, targetExplosion, reducedMotion);
      controls.autoRotate = autoRotateRef.current && !reducedMotion;
      controls.update();
      renderer.render(scene, camera);
    };

    sceneRef.current = scene;
    cameraRef.current = camera;
    rendererRef.current = renderer;
    controlsRef.current = controls;
    modelRootRef.current = modelRoot;
    setSceneReady(true);
    animate();

    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      clearGroup(modelRoot);
      floor.geometry.dispose();
      (floor.material as THREE.Material).dispose();
      grid.geometry.dispose();
      const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
      gridMaterials.forEach((material) => material.dispose());
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      scene.clear();
      partsRef.current = [];
      sceneRef.current = null;
      cameraRef.current = null;
      rendererRef.current = null;
      controlsRef.current = null;
      modelRootRef.current = null;
      setSceneReady(false);
    };
  }, [language, reducedMotion]);

  useEffect(() => {
    const modelRoot = modelRootRef.current;
    if (!sceneReady || !modelRoot) {
      return;
    }

    let cancelled = false;

    const commitAssembly = (assembly: THREE.Group, state: LoadState, message: string) => {
      if (cancelled) {
        disposeObject(assembly);
        return;
      }

      clearGroup(modelRoot);
      partsRef.current = [];
      prepareModel(assembly);
      normalizeAssembly(assembly);
      modelRoot.add(assembly);

      const parts = buildPartRecords(assembly);
      partsRef.current = parts;
      applyExplosion(parts, modeRef.current === 'exploded' ? explosionRef.current : 0, true);
      setPartCount(parts.length);
      setLoadState(state);
      setStatusMessage(message);
      resetCameraRef.current();
    };

    const useDemo = (state: LoadState, message: string) => {
      const demoAssembly = createDemoAssembly();
      commitAssembly(demoAssembly, state, message);
    };

    const modelUrl = selectedItem.modelUrl.trim();
    setLoadState('loading');
    setStatusMessage(localize(language, 'Loading model...', 'モデルを読み込み中...'));
    setPartCount(0);

    if (!modelUrl && selectedItem.source !== 'upload') {
      useDemo(
        'demo',
        localize(language, 'Demo fallback active. Upload a model or add GLB files to public/models.', 'デモ表示中。モデルをアップロードするか、GLB ファイルを public/models に追加できます。'),
      );
      return () => {
        cancelled = true;
      };
    }

    void loadAssemblyFromSource(selectedItem)
      .then((assembly) => {
        commitAssembly(
          assembly,
          selectedItem.source === 'upload' ? 'uploaded' : 'ready',
          selectedItem.source === 'upload'
            ? localize(language, 'Uploaded model loaded.', 'アップロードしたモデルを読み込みました。')
            : localize(language, 'Model loaded.', 'モデルを読み込みました。'),
        );
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }

        const message = error instanceof Error ? error.message : localize(language, 'Model could not be loaded.', 'モデルを読み込めませんでした。');
        if (selectedItem.source === 'upload') {
          clearGroup(modelRoot);
          partsRef.current = [];
          setPartCount(0);
          setLoadState('error');
          setStatusMessage(message);
          return;
        }

        useDemo(
          'fallback',
          localize(language, 'Model file was unavailable, so the demo is shown.', 'モデルファイルを読み込めないため、デモを表示しています。'),
        );
      });

    return () => {
      cancelled = true;
    };
  }, [language, sceneReady, selectedItem]);

  const stateLabel = {
    loading: localize(language, 'Loading', '読込中'),
    converting: localize(language, 'Converting', '変換中'),
    ready: localize(language, 'Ready', '準備完了'),
    uploaded: localize(language, 'Uploaded', 'アップロード'),
    demo: localize(language, 'Demo', 'デモ'),
    fallback: localize(language, 'Fallback', '代替表示'),
    error: localize(language, 'Unavailable', '利用不可'),
  }[loadState];

  return (
    <div className="space-y-5 pb-16" data-product-viewer="true">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-sm font-medium text-[var(--text-tertiary)]">{localize(language, 'Product Viewer', '製品ビューア')}</p>
          <h1 className="mt-1 text-3xl font-semibold text-[var(--text-primary)] md:text-5xl">
            {selectedItem.name}
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPTED_UPLOAD_TYPES}
            className="hidden"
            onChange={(event) => {
              void handleUploadFiles(event.currentTarget.files);
              event.currentTarget.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="secondary-button h-11"
          >
            <Upload size={16} />
            {localize(language, 'Upload 3D', '3Dをアップロード')}
          </button>
          <label className="sr-only" htmlFor="product-model-select">
            {localize(language, 'Model', 'モデル')}
          </label>
          <select
            id="product-model-select"
            value={selectedModelId}
            onChange={(event) => setSelectedModelId(event.target.value)}
            className="h-11 rounded-full border border-[color:var(--line)] bg-white/75 px-4 text-sm font-medium text-[var(--text-primary)] shadow-sm outline-none transition hover:bg-white dark:bg-white/8 dark:hover:bg-white/12"
          >
            {modelOptions.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <div className="status-pill">
            <ScanSearch size={14} />
            {partCount} {localize(language, 'parts', 'パーツ')}
          </div>
        </div>
      </div>

      <section className="relative min-h-[500px] overflow-hidden rounded-[28px] border border-[color:var(--line)] bg-[linear-gradient(180deg,rgba(248,250,252,0.9),rgba(226,232,240,0.66))] shadow-[0_28px_70px_rgba(15,23,42,0.12)] dark:bg-[linear-gradient(180deg,rgba(15,23,42,0.84),rgba(2,6,23,0.72))]">
        <div
          ref={hostRef}
          className="h-[min(72vh,680px)] min-h-[500px] w-full touch-none"
          aria-label={localize(language, 'Interactive 3D product viewer', 'インタラクティブ 3D 製品ビューア')}
        />

        <div className="pointer-events-none absolute inset-x-4 top-4 flex flex-wrap items-start justify-between gap-3">
          <div className="status-pill max-w-[min(560px,calc(100vw-3rem))] bg-white/78 text-[var(--text-primary)] shadow-sm dark:bg-slate-950/54">
            <Boxes size={14} />
            <span>{stateLabel}</span>
            {statusMessage && <span className="hidden text-[var(--text-secondary)] md:inline">{statusMessage}</span>}
          </div>
        </div>

        <div className="absolute inset-x-3 bottom-3 md:inset-x-5 md:bottom-5">
          <div className="glass-toolbar flex flex-col gap-3 rounded-[24px] p-3 md:flex-row md:items-center md:justify-between md:p-4">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <div className="inline-flex rounded-full border border-[color:var(--line)] bg-white/70 p-1 dark:bg-white/6">
                <button
                  type="button"
                  onClick={() => setMode('assembled')}
                  className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
                    mode === 'assembled'
                      ? 'bg-slate-950 text-white shadow-sm dark:bg-sky-500 dark:text-slate-950'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {localize(language, 'Assembled', '組立')}
                </button>
                <button
                  type="button"
                  onClick={() => setMode('exploded')}
                  className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
                    mode === 'exploded'
                      ? 'bg-slate-950 text-white shadow-sm dark:bg-sky-500 dark:text-slate-950'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {localize(language, 'Exploded', '分解')}
                </button>
              </div>

              <div className="flex min-w-[220px] flex-1 items-center gap-3 rounded-full border border-[color:var(--line)] bg-white/70 px-4 py-2 dark:bg-white/6">
                <span className="text-xs font-semibold text-[var(--text-secondary)]">
                  {localize(language, 'Offset', '間隔')}
                </span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={explosion}
                  onChange={(event) => setExplosion(Number(event.target.value))}
                  className="min-w-0 flex-1 accent-sky-600"
                  aria-label={localize(language, 'Explosion offset', '分解表示の間隔')}
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setAutoRotate((current) => !current)}
                className={`icon-button ${autoRotate ? 'bg-sky-500 text-white dark:bg-sky-400 dark:text-slate-950' : ''}`}
                title={localize(language, 'Auto rotate', '自動回転')}
                aria-label={localize(language, 'Auto rotate', '自動回転')}
                aria-pressed={autoRotate}
              >
                <Rotate3D size={18} />
              </button>
              <button
                type="button"
                onClick={() => resetCameraRef.current()}
                className="icon-button"
                title={localize(language, 'Reset camera', 'カメラをリセット')}
                aria-label={localize(language, 'Reset camera', 'カメラをリセット')}
              >
                <RefreshCcw size={18} />
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
